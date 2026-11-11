import type {
  AccessMode,
  AccessResponse,
  SetAccessOptions,
  AgentActivity,
  AnalyticsResponse,
  CaptionFormat,
  Comment,
  CommentsResponse,
  ApplyMetadataEditParams,
  ApplyMetadataEditResponse,
  BrowserDiagnosticsParams,
  BrowserDiagnosticsResponse,
  ContextDocument,
  EditRecordingParams,
  EditRecordingResponse,
  EditTranscriptResponse,
  Folder,
  InteractionsParams,
  InteractionsResponse,
  KeyMomentsResponse,
  MetadataEditsResponse,
  ListContextDocumentsParams,
  ListContextDocumentsResponse,
  ListRecordingsParams,
  ListRecordingsResponse,
  RecordingKind,
  OrganizeParams,
  OrganizeResponse,
  Recording,
  RecordingDetail,
  ReplaceTranscriptParams,
  ReplaceTranscriptResponse,
  SearchParams,
  SearchResponse,
  SummaryResponse,
  TranscriptResponse,
  UploadParams,
  UploadResult,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://clipy.online';
export const SDK_VERSION = '0.3.0';

export interface ClipyOptions {
  /** A `clipy_sk_live_…` key from https://clipy.online/settings/api-keys, or an OAuth access token. Defaults to `CLIPY_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  /** Per request, including the response body. Default 30s. */
  timeoutMs?: number;
  /** Retries for 429, 502, 503, 504 and network errors on safe requests. Default 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

const ACCESS_MODES: readonly AccessMode[] = ['public', 'restricted', 'private'];
const RECORDING_KINDS: readonly RecordingKind[] = [
  'bug_report',
  'feature_request',
  'product_demo',
  'walkthrough_tutorial',
  'feedback_review',
  'discussion_talk',
  'other',
];

export class ClipyError extends Error {
  readonly status: number;
  /** Machine-readable code when the API sends one (e.g. `revision_conflict`). */
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ClipyError';
    this.status = status;
    this.body = body;
    const code = (body as { code?: unknown } | null)?.code;
    this.code = typeof code === 'string' ? code : null;
  }
}

/**
 * The upload became a recording, but /complete never confirmed it: the
 * server answered with a pending or failure state (`code`, for example
 * `access_mode_pending`, `queue_pending` or `claim_pending`) after the row was
 * attached. The recording exists as `publicId`; uploading again would create
 * a duplicate. For `access_mode_pending`, set the sharing with `setAccess`.
 */
export class UploadNotConfirmedError extends ClipyError {
  readonly publicId: string;

  constructor(publicId: string, cause: ClipyError) {
    super(
      cause.status,
      `Uploaded as ${publicId}, but completion was not confirmed (${cause.code ?? `HTTP ${cause.status}`}): ${cause.message}. Do not upload again.`,
      cause.body,
    );
    this.name = 'UploadNotConfirmedError';
    this.publicId = publicId;
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Sent as multipart/form-data instead of a JSON body. */
  form?: FormData;
  /** Read as text instead of JSON. */
  text?: boolean;
  bytes?: boolean;
  /** Safe to retry automatically. Defaults to true for GET. */
  retry?: boolean;
  /** Per-request timeout; defaults to the client's `timeoutMs`. */
  timeoutMs?: number;
}

/** A 4 MiB part needs ~1.1 Mbit/s to finish in 30 s, so parts get longer, as in the CLI and MCP. */
const UPLOAD_PART_TIMEOUT_MS = 120_000;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

export class Clipy {
  readonly recordings: Recordings;
  readonly folders: Folders;
  readonly contextDocuments: ContextDocuments;
  readonly integrations: Integrations;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  /** @internal Base for share and context links. */
  get baseUrlForLinks(): string {
    return this.baseUrl;
  }
  /** @internal */
  readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClipyOptions = {}) {
    const apiKey = options.apiKey ?? readEnv('CLIPY_API_KEY');
    if (!apiKey) {
      throw new Error('Pass apiKey or set CLIPY_API_KEY. Create a key at https://clipy.online/settings/api-keys');
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? readEnv('CLIPY_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error('No fetch implementation available; pass options.fetch');
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.recordings = new Recordings(this);
    this.folders = new Folders(this);
    this.contextDocuments = new ContextDocuments(this);
    this.integrations = new Integrations(this);
  }

  /** Search transcripts, titles and imported context across your library. */
  search(params: SearchParams): Promise<SearchResponse> {
    return this.request('GET', '/api/v1/search', {
      query: { q: params.q, kinds: params.kinds?.join(','), limit: params.limit },
    });
  }

  /** @internal Low-level request; public so you can reach endpoints the SDK does not wrap yet. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
      else url.searchParams.set(key, String(value));
    }
    const retry = opts.retry ?? method === 'GET';
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: opts.text ? 'text/markdown' : 'application/json',
            'user-agent': `clipy-sdk-typescript/${SDK_VERSION}`,
            ...(opts.body !== undefined && !opts.form ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        });
        if (response.ok) {
          const value = opts.bytes
            ? new Uint8Array(await response.arrayBuffer())
            : opts.text
              ? await response.text()
              : await response.json();
          clearTimeout(timer);
          return value as T;
        }
      } catch (error) {
        clearTimeout(timer);
        if (retry && attempt < this.maxRetries) {
          attempt += 1;
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }
      clearTimeout(timer);

      if (retry && RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 60) * 1000
            : 500 * 2 ** (attempt - 1),
        );
        continue;
      }
      const text = await response.text().catch(() => '');
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // keep the raw text
      }
      const message =
        (body as { error?: unknown } | null)?.error && typeof (body as { error: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
      throw new ClipyError(response.status, message, body);
    }
  }
}

const enc = encodeURIComponent;

/** The server accepts parts of at most 4 MiB. */
const UPLOAD_PART_BYTES = 4 * 1024 * 1024;

/** WebM starts with the EBML magic; MP4 and QuickTime carry `ftyp` at byte 4. */
/**
 * Whether a failed /complete may have committed without our hearing about it:
 * no HTTP response at all (network error, timeout), or a 502/504 from the
 * gateway in front of the app. Every answer the route itself gives, coded or
 * not (503 access_mode_pending, a 500 that marked the recording failed), is
 * an explicit outcome and is never turned into a success.
 */
/** /complete answers that mean the recording exists or is being committed. */
const PENDING_COMPLETION_CODES = new Set(['access_mode_pending', 'queue_pending', 'claim_pending']);

function completionWasAmbiguous(error: unknown): boolean {
  if (!(error instanceof ClipyError)) return true;
  return error.code === null && (error.status === 502 || error.status === 504);
}

function sniffContainer(bytes: Uint8Array): 'webm' | 'mp4' {
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 8 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'mp4';
  throw new Error('upload expects a WebM or MP4 (or QuickTime .mov) file');
}

class Recordings {
  constructor(private readonly client: Clipy) {}

  list(params: ListRecordingsParams = {}): Promise<ListRecordingsResponse> {
    return this.client.request('GET', '/api/v1/recordings', {
      query: { q: params.q, status: params.status, page: params.page, limit: params.limit },
    });
  }

  /** Iterates every recording, fetching pages as needed. */
  async *listAll(params: Omit<ListRecordingsParams, 'page'> = {}): AsyncGenerator<Recording> {
    for (let page = 1; ; page += 1) {
      const result = await this.list({ ...params, page, limit: params.limit ?? 100 });
      yield* result.recordings;
      if (!result.pagination.hasMore) return;
    }
  }

  async get(id: string): Promise<RecordingDetail> {
    const { recording } = await this.client.request<{ recording: RecordingDetail }>(
      'GET',
      `/api/v1/recordings/${enc(id)}`,
    );
    return recording;
  }

  /** Needs `recordings:write`. `expectedResult` is what the recorder expected
   *  to happen; pass `null` to clear it or `description`. */
  async update(
    id: string,
    changes: { name?: string; description?: string | null; expectedResult?: string | null },
  ): Promise<Recording | null> {
    const { recording } = await this.client.request<{ recording: Recording | null }>(
      'PATCH',
      `/api/v1/recordings/${enc(id)}`,
      { body: changes },
    );
    return recording;
  }

  transcript(id: string): Promise<TranscriptResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/transcript`);
  }

  /**
   * The transcript as a caption file: SubRip, WebVTT or plain text. Throws a
   * `ClipyError` with status 409 while the transcript is not ready yet.
   */
  captions(id: string, format: CaptionFormat): Promise<string> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/transcript`, {
      query: { format },
      text: true,
    });
  }

  /**
   * Permanently deletes a recording and its media. There is no undo. Needs a
   * key with `recordings:delete` (OAuth tokens never carry it).
   */
  delete(id: string): Promise<{ deleted: true; recordingId: string }> {
    return this.client.request('DELETE', `/api/v1/recordings/${enc(id)}`, {
      query: { confirm: id },
    });
  }

  /** Needs `comments:read`. */
  comments(id: string): Promise<CommentsResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/comments`);
  }

  /** Needs `comments:write`. Posts a comment at `timestampMs`, as the key's owner. */
  async comment(id: string, params: { body: string; timestampMs: number }): Promise<Comment> {
    const { comment } = await this.client.request<{ comment: Comment }>(
      'POST',
      `/api/v1/recordings/${enc(id)}/comments`,
      { body: { kind: 'comment', ...params } },
    );
    return comment;
  }

  /** Needs `comments:write`. */
  async reply(id: string, params: { body: string; parentCommentId: string }): Promise<Comment> {
    const { comment } = await this.client.request<{ comment: Comment }>(
      'POST',
      `/api/v1/recordings/${enc(id)}/comments`,
      { body: { kind: 'reply', ...params } },
    );
    return comment;
  }

  /**
   * Needs `analytics:read`. Viewer analytics over the recording's whole life. `rangeDays` sets only
   * the window of the `daily` series. Free accounts get `{gated: true, viewCount, teaser}`.
   */
  analytics(id: string, params: { rangeDays?: number } = {}): Promise<AnalyticsResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/analytics`, {
      query: { range: params.rangeDays },
    });
  }

  /**
   * Uploads a WebM or MP4 (QuickTime .mov included) to the library: initiate,
   * 4 MiB parts, finalize, complete. Needs a key with `ingest`; counts toward
   * the account's recording allowance. Every step is idempotent, so transient
   * failures are retried, and a failed upload is aborted server-side.
   *
   * Takes bytes rather than a path so it runs in any runtime. In Node:
   * `clipy.recordings.upload(await readFile('demo.mp4'), { name: 'Demo' })`.
   *
   * An `UploadNotConfirmedError` means the recording exists (`publicId`) but
   * /complete never confirmed it; never upload again. With code
   * `access_mode_pending` its requested sharing was not applied: fix it with
   * `setAccess`.
   */
  async upload(data: Uint8Array | ArrayBuffer | Blob, params: UploadParams = {}): Promise<UploadResult> {
    // Checked before anything is sent: /complete ignores a value it does not
    // know, so a typo like "privte" would otherwise upload with the account's
    // default access, which may be public.
    if (params.accessMode !== undefined && !ACCESS_MODES.includes(params.accessMode)) {
      throw new TypeError(`accessMode must be one of ${ACCESS_MODES.join(', ')}`);
    }
    if (params.recordingKind !== undefined && !RECORDING_KINDS.includes(params.recordingKind)) {
      throw new TypeError(`recordingKind must be one of ${RECORDING_KINDS.join(', ')}`);
    }
    // A Blob (a browser File included) is never read whole: only its header
    // here, then one 4 MiB slice per part, so a long recording does not have
    // to fit in memory before the first byte is sent.
    const bytes = data instanceof Blob ? null : data instanceof Uint8Array ? data : new Uint8Array(data);
    const size = bytes ? bytes.length : (data as Blob).size;
    const head = bytes ? bytes.subarray(0, 8) : new Uint8Array(await (data as Blob).slice(0, 8).arrayBuffer());
    const container = sniffContainer(head);
    const recordingId = globalThis.crypto.randomUUID();
    const sourceVersion = (params.sourceVersion ?? `sdk-ts/${SDK_VERSION}`).slice(0, 32);
    const init = await this.client.request<{ uploadToken?: string; publicId?: string }>(
      'POST',
      '/api/videos/raw-upload/initiate',
      { body: { recordingId, createVideoRow: true, sourceVersion }, retry: true },
    );
    const uploadToken = init.uploadToken;
    const publicId = init.publicId;
    if (!uploadToken || !publicId) {
      throw new ClipyError(502, 'Upload initiate did not return an upload token and public id', init);
    }
    try {
      const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
      for (let offset = 0, part = 1; offset < size; offset += UPLOAD_PART_BYTES, part += 1) {
        const form = new FormData();
        form.append('recordingId', recordingId);
        form.append('uploadToken', uploadToken);
        form.append('partNumber', String(part));
        const end = Math.min(offset + UPLOAD_PART_BYTES, size);
        const slice = bytes
          ? new Blob([bytes.slice(offset, end)], { type: mime })
          : (data as Blob).slice(offset, end, mime);
        form.append('file', slice, `part-${part}.${container}`);
        await this.client.request('POST', '/api/videos/raw-upload/chunk', {
          form,
          retry: true,
          timeoutMs: Math.max(this.client.timeoutMs, UPLOAD_PART_TIMEOUT_MS),
        });
      }
      const ids = { recordingId, uploadToken };
      await this.client.request('POST', '/api/videos/raw-upload/finalize', { body: ids, retry: true });
      await this.client.request('POST', '/api/videos/raw-upload/complete', {
        body: {
          ...ids,
          sourceVersion,
          ...(params.name ? { name: params.name, nameIsUserProvided: true } : {}),
          ...(params.description ? { description: params.description } : {}),
          ...(params.recordingKind ? { recordingKind: params.recordingKind } : {}),
          ...(params.expectedResult?.trim() ? { expectedResult: params.expectedResult.trim() } : {}),
          ...(params.accessMode ? { accessMode: params.accessMode } : {}),
          ...(params.narration ? { narration: params.narration } : {}),
        },
        retry: true,
      });
    } catch (error) {
      // A coded pending answer from /complete (access_mode_pending,
      // queue_pending, claim_pending) already says the recording exists or is
      // being committed: report it directly, without depending on an abort
      // request that could itself fail, and without aborting a commit that is
      // still in flight.
      if (error instanceof ClipyError && error.code !== null && PENDING_COMPLETION_CODES.has(error.code)) {
        throw new UploadNotConfirmedError(publicId, error);
      }
      // A /complete whose responses were all lost may still have committed.
      // The server refuses to abort an upload that already became a recording
      // (409 already_attached), and that refusal is the proof it succeeded:
      // reporting a failure here would make the caller upload a duplicate.
      // Only for an ambiguous failure, though: an explicit refusal such as
      // 503 access_mode_pending means the row exists but the requested
      // sharing was never applied, so it may still be public. That is a
      // failure the caller must see, never a success with a share link.
      const abortSaysCompleted = await this.client
        .request('POST', '/api/videos/raw-upload/abort', { body: { recordingId, uploadToken } })
        .then(
          () => false,
          (abortError: unknown) => abortError instanceof ClipyError && abortError.code === 'already_attached',
        );
      if (abortSaysCompleted && completionWasAmbiguous(error)) {
        // fall through to the success result
      } else if (abortSaysCompleted && error instanceof ClipyError) {
        // The recording exists but its completion was not confirmed: name it
        // rather than let the caller upload the file again.
        throw new UploadNotConfirmedError(publicId, error);
      } else {
        throw error;
      }
    }
    const base = this.client.baseUrlForLinks;
    return {
      publicId,
      shareUrl: `${base}/video/${publicId}`,
      contextUrl: `${base}/video/${publicId}.arec`,
      sizeBytes: size,
    };
  }

  /** Needs `ingest`. Read `transcript().transcript.revision` first and pass it as `expectedRevision`. */
  replaceTranscript(id: string, params: ReplaceTranscriptParams): Promise<ReplaceTranscriptResponse> {
    return this.client.request('PUT', `/api/v1/recordings/${enc(id)}/transcript`, { body: params });
  }

  summary(id: string): Promise<SummaryResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/summary`);
  }

  keyMoments(id: string): Promise<KeyMomentsResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/key-moments`);
  }

  interactions(id: string, params: InteractionsParams = {}): Promise<InteractionsResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/interactions`, {
      query: {
        fromMs: params.fromMs,
        toMs: params.toMs,
        types: params.types?.join(','),
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  }

  browserDiagnostics(id: string, params: BrowserDiagnosticsParams = {}): Promise<BrowserDiagnosticsResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/browser-diagnostics`, {
      query: {
        ...params,
        kinds: params.kinds?.join(','),
        levels: params.levels?.join(','),
      } as Query,
    });
  }

  agentActivity(id: string): Promise<AgentActivity> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/agent-activity`);
  }

  /** Record that an agent read this recording (shown on the watch page). */
  recordAgentRead(id: string, source: 'mcp' | 'cli' | 'web'): Promise<{ recorded: true }> {
    return this.client.request('POST', `/api/v1/recordings/${enc(id)}/agent-activity`, {
      body: { kind: 'read', source },
    });
  }

  /** Current editable metadata, its revision and recent edit receipts. Needs `recordings:write`. */
  metadataEdits(id: string, params: { limit?: number } = {}): Promise<MetadataEditsResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/edits`, { query: { ...params } });
  }

  /**
   * Revision-checked, idempotent title/description/CTA edit. Safe to retry
   * with the same idempotencyKey. Needs `recordings:write`.
   */
  applyMetadataEdit(id: string, params: ApplyMetadataEditParams): Promise<ApplyMetadataEditResponse> {
    return this.client.request('POST', `/api/v1/recordings/${enc(id)}/edits`, { body: params, retry: true });
  }

  async getAccess(id: string): Promise<AccessResponse['access']> {
    const { access } = await this.client.request<AccessResponse>('GET', `/api/v1/recordings/${enc(id)}/access`);
    return access;
  }

  /**
   * Needs `recordings:write`. Changes the share mode, and optionally whether a
   * public recording is listed in search results. Never changes who is on a
   * restricted recording's list.
   */
  async setAccess(id: string, mode: AccessMode, options: SetAccessOptions = {}): Promise<AccessResponse['access']> {
    const body: { mode: AccessMode; searchDiscoverable?: boolean } = { mode };
    if (typeof options.searchDiscoverable === 'boolean') body.searchDiscoverable = options.searchDiscoverable;
    const { access } = await this.client.request<AccessResponse>('PUT', `/api/v1/recordings/${enc(id)}/access`, {
      body,
      retry: true,
    });
    return access;
  }

  /** Needs `recordings:write`. */
  async organize(id: string, params: OrganizeParams): Promise<OrganizeResponse['recording']> {
    const { recording } = await this.client.request<OrganizeResponse>(
      'PATCH',
      `/api/v1/recordings/${enc(id)}/organize`,
      { body: params },
    );
    return recording;
  }

  /** Word-level transcript for cutting the video. Needs `recordings:write`. */
  editTranscript(id: string, params: { fromWord?: number; limit?: number } = {}): Promise<EditTranscriptResponse> {
    return this.client.request('GET', `/api/v1/recordings/${enc(id)}/edit`, { query: { ...params } });
  }

  /** Cut words or ranges from the video. Pass `dryRun: true` first. Needs `recordings:write`. */
  edit(id: string, params: EditRecordingParams): Promise<EditRecordingResponse> {
    return this.client.request('POST', `/api/v1/recordings/${enc(id)}/edit`, { body: params });
  }

  /**
   * Polls until the recording reaches `until` (default `usable`: transcript and
   * summary ready) or fails. Webhooks are the better fit for servers; this is
   * for scripts and CI.
   */
  async waitUntilReady(
    id: string,
    opts: { until?: 'playable' | 'usable' | 'complete'; timeoutMs?: number; pollMs?: number } = {},
  ): Promise<RecordingDetail> {
    const until = opts.until ?? 'usable';
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    const pollMs = opts.pollMs ?? 5_000;
    for (;;) {
      const recording = await this.get(id);
      if (recording.stage === 'failed' || recording.agentReadiness === 'failed') {
        throw new ClipyError(422, `Recording ${id} failed processing`, recording);
      }
      const done =
        until === 'playable'
          ? recording.status === 'ready'
          : until === 'usable'
            ? recording.agentReadiness === 'usable' || recording.agentReadiness === 'complete'
            : recording.agentReadiness === 'complete';
      if (done) return recording;
      if (Date.now() + pollMs > deadline) {
        throw new ClipyError(408, `Timed out waiting for recording ${id} to become ${until}`, recording);
      }
      await sleep(pollMs);
    }
  }
}

class Folders {
  constructor(private readonly client: Clipy) {}

  async list(): Promise<Folder[]> {
    const { folders } = await this.client.request<{ folders: Folder[] }>('GET', '/api/v1/folders');
    return folders;
  }

  /** Returns the existing folder when one with the same name (case-insensitive) exists. Needs `recordings:write`. */
  create(name: string): Promise<{ folder: Folder; created: boolean }> {
    return this.client.request('POST', '/api/v1/folders', { body: { name }, retry: true });
  }
}

class ContextDocuments {
  constructor(private readonly client: Clipy) {}

  list(params: ListContextDocumentsParams = {}): Promise<ListContextDocumentsResponse> {
    return this.client.request('GET', '/api/v1/context-documents', { query: { ...params } });
  }

  async get(id: string): Promise<ContextDocument> {
    const { document } = await this.client.request<{ document: ContextDocument }>(
      'GET',
      `/api/v1/context-documents/${enc(id)}`,
    );
    return document;
  }

  /** The AREC Markdown document. */
  arec(id: string): Promise<string> {
    return this.client.request('GET', `/api/v1/context-documents/${enc(id)}/recording.arec`, { text: true });
  }

  /** Raw image bytes for one frame or artifact. */
  artifact(id: string, artifactId: string): Promise<Uint8Array> {
    return this.client.request('GET', `/api/v1/context-documents/${enc(id)}/artifacts/${enc(artifactId)}`, {
      bytes: true,
    });
  }

  /** Which provider ids are already imported. */
  async existing(sourceKind: 'youtube' | 'loom', providerIds: string[]): Promise<Array<{ providerId: string; publicId: string }>> {
    const { existing } = await this.client.request<{ existing: Array<{ providerId: string; publicId: string }> }>(
      'POST',
      '/api/v1/context-documents/existing',
      { body: { sourceKind, providerIds }, retry: true },
    );
    return existing;
  }

  /** Needs `ingest`. `null` removes it from its folder. */
  setFolder(id: string, folderId: string | null): Promise<{ folderId: string | null }> {
    return this.client.request('PATCH', `/api/v1/context-documents/${enc(id)}/folder`, {
      body: { folderId },
      retry: true,
    });
  }

  /** Needs `ingest`. Replaces the whole tag set. */
  setTags(id: string, tags: string[]): Promise<{ tags: string[] }> {
    return this.client.request('PUT', `/api/v1/context-documents/${enc(id)}/tags`, { body: { tags }, retry: true });
  }

  /** Needs `ingest`. */
  delete(id: string): Promise<{ deleted: true; id: string; publicId: string }> {
    return this.client.request('DELETE', `/api/v1/context-documents/${enc(id)}`);
  }
}

export type IntegrationDestination = 'jira' | 'confluence' | 'linear';

export interface IntegrationTarget {
  id: string;
  name: string;
  key: string | null;
  site: string | null;
  /** Jira only. */
  issueTypes?: Array<{ id: string; name: string }>;
}

export interface SendRecordingParams {
  destination: IntegrationDestination;
  /** From `integrations.targets()`. */
  targetId: string;
  /** Required for Jira. */
  issueTypeId?: string;
  title?: string;
  note?: string;
  /** Reuse when retrying: the issue already created is returned instead of a duplicate. */
  requestKey?: string;
}

export interface SendRecordingResult {
  destination: IntegrationDestination;
  externalId: string;
  key: string | null;
  url: string;
  title: string;
  replayed: boolean;
}

/**
 * Jira, Confluence and Linear. Connecting a tool is a one-time browser consent
 * at https://clipy.online/settings/integrations; the API can only use it.
 */
class Integrations {
  constructor(private readonly client: Clipy) {}

  /** Which destinations are connected. */
  list(): Promise<{
    connectUrl: string;
    destinations: Array<{ destination: IntegrationDestination; label: string; available: boolean; connected: boolean }>;
  }> {
    return this.client.request('GET', '/api/v1/integrations');
  }

  /** Jira projects (with issue types), Confluence spaces or Linear teams. */
  async targets(destination: IntegrationDestination, params: { q?: string } = {}): Promise<IntegrationTarget[]> {
    const { targets } = await this.client.request<{ targets: IntegrationTarget[] }>(
      'GET',
      `/api/v1/integrations/${enc(destination)}/targets`,
      { query: { ...params } },
    );
    return targets;
  }

  /** Create a Jira issue, Confluence page or Linear issue from a recording. Needs `recordings:write`. */
  send(recordingId: string, params: SendRecordingParams): Promise<SendRecordingResult> {
    return this.client.request('POST', `/api/v1/recordings/${enc(recordingId)}/send`, {
      body: params,
      retry: Boolean(params.requestKey),
    });
  }

  /** What this recording was already sent to. */
  async sends(recordingId: string): Promise<Array<{ id: string; destination: IntegrationDestination; key: string | null; url: string; createdAt: string }>> {
    const { sends } = await this.client.request<{ sends: Array<{ id: string; destination: IntegrationDestination; key: string | null; url: string; createdAt: string }> }>(
      'GET',
      `/api/v1/recordings/${enc(recordingId)}/send`,
    );
    return sends;
  }
}
