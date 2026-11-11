/**
 * Response and request shapes for the Clipy REST API v1.
 * Field names match the wire format exactly. Reference: https://clipy.online/docs/api
 */

export type RecordingStage =
  | 'uploading'
  | 'transcoding'
  | 'transcribing'
  | 'annotating'
  | 'ready'
  | 'failed';

export type AgentReadiness = 'preparing' | 'usable' | 'complete' | 'failed';

/** `'none'` means the artifact will never exist for this recording. */
export type ArtifactStatus = 'ready' | 'pending' | 'queued' | 'processing' | 'failed' | 'skipped' | 'none' | (string & {});

export interface Recording {
  /** The public id used in watch URLs and every API path. */
  id: string;
  name: string;
  description: string | null;
  status: string;
  stage: RecordingStage;
  agentReadiness: AgentReadiness;
  durationSeconds: number | null;
  sourcePlatform: string | null;
  recordingKind: string | null;
  recordingKindConfidence: number | null;
  /** What the recorder expected to happen; compare the recording against it. Null when nobody stated it. */
  expectedResult: string | null;
  transcriptStatus: string | null;
  summaryStatus: string | null;
  keyMomentsStatus: string | null;
  editStatus: string | null;
  webUrl: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingDetail extends Recording {
  /** Present for Mac recordings that carry a capture sidecar. */
  capture?: {
    sourceType: 'display' | 'window' | 'area' | string | null;
    appName: string | null;
    windowTitle: string | null;
    /** For a window source: the window alone, or the screen area under it. */
    windowCapture?: 'window' | 'area';
  };
  /**
   * What this recording did not capture. Present once the recording is
   * ready. Where it lacks evidence, ask the user instead of inferring.
   */
  missingEvidence?: MissingEvidence;
}

export type EvidenceGapKind =
  | 'browser_logs'
  | 'cursor'
  | 'speech'
  | 'off_capture_clicks'
  | 'window_only'
  | 'pointer_without_click'
  | 'expected_result';

export interface EvidenceGap {
  /** One of EvidenceGapKind; newer servers may add kinds. */
  kind: EvidenceGapKind | (string & {});
  reason: string;
  /** Where the gap sits in the recording, when it is a moment or a stretch. */
  atMs?: number[];
}

export interface MissingEvidence {
  instruction: string;
  gaps: EvidenceGap[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ListRecordingsParams {
  q?: string;
  status?: Array<'ready' | 'processing' | 'failed' | 'pending' | 'queued'>;
  /** 1-based. */
  page?: number;
  /** 1 to 100, default 20. */
  limit?: number;
}

export interface ListRecordingsResponse {
  recordings: Recording[];
  pagination: Pagination;
}

interface ArtifactEnvelope {
  recordingId: string;
  status: ArtifactStatus;
  stage?: RecordingStage;
  /** A human sentence explaining what is still running. */
  hint?: string;
  error?: string | null;
}

export interface TranscriptSegment {
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  text: string;
}

export interface Transcript {
  language: string;
  wordCount: number;
  plaintext: string;
  segments: TranscriptSegment[];
  /** Pass back as `expectedRevision` when replacing the transcript. */
  revision: string;
}

export interface TranscriptResponse extends ArtifactEnvelope {
  transcript: Transcript | null;
}

export interface ReplaceTranscriptParams {
  expectedRevision: string;
  segments?: TranscriptSegment[];
  plaintext?: string;
  language?: string;
}

export interface ReplaceTranscriptResponse {
  recordingId: string;
  status: 'ready';
  source: 'agent-edit';
  segmentCount: number;
  wordCount: number;
  revision: string;
  summaryStatus: 'queued' | 'failed';
}

export interface Summary {
  tldr: string;
  keyPoints: string[];
  actionItems: string[];
  chapters: Array<{ startSec: number; label: string }>;
  model: string;
}

export interface SummaryResponse extends ArtifactEnvelope {
  summary: Summary | null;
}

export interface KeyMoment {
  tMs: number;
  /** m:ss */
  timeLabel: string;
  source: 'deixis' | 'click' | 'fused' | 'hover' | 'draw' | 'flare' | (string & {});
  caption: string;
  frameUrl: string | null;
  cropUrl: string | null;
  /** Normalized 0..1 within the frame. */
  x: number | null;
  y: number | null;
  confidence: number;
  motion: {
    relation: 'move' | 'drag';
    targetX: number;
    targetY: number;
    targetFrameUrl: string | null;
    confidence: number | null;
  } | null;
}

export interface KeyMomentsResponse extends ArtifactEnvelope {
  cursorTelemetry: 'present' | 'absent';
  moments: KeyMoment[];
}

export type InteractionKind =
  | 'navigation'
  | 'pointer'
  | 'click'
  | 'drag'
  | 'scroll'
  | 'dwell'
  | 'typing'
  | 'highlight';

export interface InteractionsParams {
  fromMs?: number;
  toMs?: number;
  types?: InteractionKind[];
  /** 1 to 250, default 100. */
  limit?: number;
  cursor?: string;
}

export interface InteractionEvent {
  id: string;
  kind: InteractionKind;
  tMs: number;
  endMs?: number;
  position?: { x: number; y: number };
  targetPosition?: { x: number; y: number };
  target?: { role: string | null; label: string | null };
  pageUrl?: string;
  button?: 'primary' | 'middle' | 'secondary' | 'other';
  direction?: 'up' | 'down' | 'left' | 'right' | 'mixed';
  eventCount?: number;
  evidence?: { tMs: number; caption: string; frameUrl: string | null; cropUrl: string | null };
  provenance: 'captured' | 'derived';
}

export interface InteractionsResponse {
  type: 'clipy.interaction_timeline';
  version: number;
  status: 'present' | 'absent' | 'partial' | 'unreadable' | 'preparing';
  revision?: string;
  pagination?: { nextCursor: string | null; limit: number };
  coordinateSpace: 'capture';
  coordinateNote: string;
  sources: Record<string, string>;
  coverage: {
    totalEvents: number;
    returnedEvents: number;
    truncated: boolean;
    droppedSourceEvents: number;
    counts: Record<string, number>;
    omittedPointerEvents?: number;
  };
  privacy: Record<string, unknown>;
  events: InteractionEvent[];
  recordingId: string;
  query: { fromMs: number; toMs: number | null; types: string[] };
}

export interface BrowserDiagnosticsParams {
  kinds?: Array<'console' | 'error' | 'network' | 'stream' | 'action' | 'navigation'>;
  levels?: Array<'debug' | 'info' | 'log' | 'warn' | 'error'>;
  /** `5xx`, `4xx`, `failed`, or an exact code such as `404`. */
  status?: string;
  method?: string;
  host?: string;
  bodies?: 'none' | 'errors' | 'all';
  fromMs?: number;
  toMs?: number;
  after?: number;
  limit?: number;
}

export interface BrowserDiagnosticsResponse {
  recordingId: string;
  attestation: 'page-reported' | 'browser-reported';
  attestationNote: string;
  /** The raw diagnostics sidecar (snake_case fields), or null when none was captured. */
  diagnostics: {
    schema_version: number;
    source: 'extension' | 'cdp' | string;
    policy: Record<string, unknown>;
    environment: Record<string, unknown> | null;
    events: Array<{ kind: string; time_ms: number; [key: string]: unknown }>;
    dropped_events: number;
    [key: string]: unknown;
  } | null;
  page?: { totalEvents: number; totalMatching: number; returned: number; nextAfter: number | null };
}

export interface AgentActivity {
  readCount: number;
  lastReadAt: string | null;
  verifications: Array<{ publicId: string; name: string; createdAt: string }>;
}

export type AccessMode = 'public' | 'restricted' | 'private';

export interface AccessResponse {
  access: {
    mode: AccessMode;
    domains: string[];
    grantedPeople: number;
    /** "List this recording in search results". Only ever true on a public link. */
    searchDiscoverable: boolean;
  };
}

export interface SetAccessOptions {
  /**
   * Turn "List this recording in search results" on or off. On needs a public
   * link with no password, no expiry and a visible share image (400
   * otherwise). Omit to leave it as it is.
   */
  searchDiscoverable?: boolean;
}

export interface OrganizeParams {
  /** `null` removes the recording from its folder; omit to leave it. */
  folderId?: string | null;
  addTags?: string[];
  removeTags?: string[];
}

export interface OrganizeResponse {
  recording: { id: string; folderId: string | null; tags: string[] };
}

export interface EditTranscriptResponse {
  recordingId: string;
  revision: number;
  editable: boolean;
  blockedReason: string | null;
  timeline: 'original';
  originalDurationMs: number;
  editedDurationMs: number;
  keptOriginal: boolean;
  cuts: Array<{ startMs: number; endMs: number }>;
  transcript: {
    language: string;
    approximateWordTimings: boolean;
    totalWords: number;
    fromWord: number;
    nextFromWord: number | null;
    words: Array<{ i: number; startMs: number; endMs: number; text: string; filler?: true; removed?: true }>;
  } | null;
  fillerWordCount: number;
  autoZoom: { applied: boolean; available: boolean; reason: string | null; zoomCount: number; note?: string };
}

export type WordSelection = number | { from: number; to?: number };

export interface EditRecordingParams {
  expectedRevision?: number;
  restoreOriginal?: true;
  removeWords?: WordSelection[];
  restoreWords?: WordSelection[];
  removeRanges?: Array<{ startMs: number; endMs: number }>;
  restoreRanges?: Array<{ startMs: number; endMs: number }>;
  removeFillerWords?: true;
  autoZoom?: boolean;
  /** Preview the edit without rendering it. Recommended before every real edit. */
  dryRun?: true;
}

export interface EditRecordingResponse {
  dryRun?: true;
  status?: 'queued';
  revision: number;
  cutCount: number;
  autoZoom: boolean;
  zoomCount?: number;
  originalDurationMs: number;
  finalDurationMs: number;
  removedWordCount: number;
  removedWords: string[];
  restoredWordCount: number;
  restoredWords: string[];
  truncated?: true;
  fillerWordsFound?: number;
  fillerWordsSkipped?: number;
  fillerNote?: string;
  note?: string;
}

export interface MetadataEditChanges {
  name?: string;
  description?: string | null;
  cta?: { label: string; url: string } | null;
}

export interface MetadataEditReceipt {
  id: string;
  actorType: 'api_key' | 'oauth' | 'session';
  idempotencyKey: string;
  baseRevision: string;
  resultRevision: string;
  changes: MetadataEditChanges;
  diff: Array<{ field: 'name' | 'description' | 'cta' | 'autoNamed'; before: unknown; after: unknown }>;
  createdAt: string;
}

export interface MetadataEditsResponse {
  recordingId: string;
  revision: string;
  editable: { name: string; description: string | null; cta: { label: string | null; url: string | null } | null };
  supportedChanges: Array<'name' | 'description' | 'cta'>;
  recentEdits: MetadataEditReceipt[];
}

export interface ApplyMetadataEditParams {
  /** `revision` from `metadataEdits()`. */
  expectedRevision: string;
  /** 8 to 128 characters; replaying the same key returns the original receipt. */
  idempotencyKey: string;
  dryRun: boolean;
  changes: MetadataEditChanges;
}

export interface ApplyMetadataEditResponse {
  recordingId: string;
  dryRun: boolean;
  applied: boolean;
  baseRevision?: string;
  resultRevision?: string;
  diff?: MetadataEditReceipt['diff'];
  resultingState?: { name: string; description: string | null; cta: { label: string; url: string } | null };
  replayed?: boolean;
  receipt?: MetadataEditReceipt;
  searchIndexStatus?: 'unchanged' | 'queued' | 'failed';
}

export interface SearchParams {
  /** 3 to 512 characters. */
  q: string;
  kinds?: Array<'recording' | 'context'>;
  /** 1 to 50, default 20. */
  limit?: number;
}

export interface SearchResult {
  kind: 'recording' | 'context';
  sourceId: string;
  publicId: string;
  title: string;
  startMs: number | null;
  endMs: number | null;
  resolution: 'lexical' | 'refined' | 'window' | 'document';
  snippet: string;
  score: number;
  lexScore: number | null;
  vecScore: number | null;
  similarity: number | null;
  /** Watch URL, with `?t=` when the hit has a timestamp. */
  url: string;
}

export interface SearchResponse {
  query: string;
  /** True when the semantic index was unavailable and these are keyword matches only. */
  degraded: boolean;
  semantic: {
    status: 'ok' | 'unavailable' | 'failed' | 'intentionally_skipped';
    detail?: string;
    candidates?: number;
    kept?: number;
    topSimilarity?: number;
  };
  count: number;
  tookMs: number;
  results: SearchResult[];
}

/** Folder rows are returned in snake_case. */
export interface Folder {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  video_count: number;
  context_document_count: number;
}

export interface ContextDocumentSummary {
  id: string;
  publicId: string;
  title: string;
  sourceKind: 'youtube' | 'loom' | 'local' | 'url' | (string & {});
  sourceUrl: string | null;
  durationMs: number;
  language: string | null;
  profile: 'transcript' | 'visual';
  folderId: string | null;
  tags: string[];
  segmentCount: number;
  frameCount: number;
  ingestStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextDocument extends ContextDocumentSummary {
  source: { kind: string; canonicalUrl: string | null; providerId: string | null; contentHash: string | null };
  arecVersion: string;
  bundleVersion: number;
  compiler: { name: string; version: string };
  arecMarkdown: string;
  transcript: {
    source: string;
    language: string | null;
    segments: Array<{ startMs: number; endMs: number; text: string }>;
    plaintext: string;
  };
  sufficiency: unknown;
  summary: {
    status: string;
    model: string | null;
    summarizedAt: string | null;
    tldr: string | null;
    keyPoints: string[];
    actionItems: string[];
  };
  classification: Record<string, unknown> | null;
  artifacts: Array<{
    id: string;
    kind: string;
    timestampMs: number;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    sha256: string;
    caption: string | null;
    url: string;
  }>;
}

export interface ListContextDocumentsParams {
  q?: string;
  tag?: string;
  folderId?: string;
  limit?: number;
  offset?: number;
}

export interface ListContextDocumentsResponse {
  documents: ContextDocumentSummary[];
  pagination: { limit: number; offset: number; count: number };
}

export interface Comment {
  id: string;
  parentCommentId: string | null;
  /** Null once deleted. */
  body: string | null;
  /** Position in the recording a top-level comment points at. */
  timestampMs: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  resolvedAt: string | null;
  author: { name: string; avatarUrl: string | null };
  /** True when the key's owner wrote it. */
  authoredByViewer: boolean;
  reactions: Array<Record<string, unknown>>;
}

export interface CommentsResponse {
  recordingId: string;
  commentsEnabled: boolean;
  comments: Comment[];
}

export type AnalyticsResponse =
  | {
      recordingId: string;
      gated: true;
      analyticsDisabled: boolean;
      viewCount: number;
      teaser: { sessions: number; uniqueViewers: number };
      upgradeUrl: string;
    }
  | {
      recordingId: string;
      gated: false;
      analyticsDisabled: boolean;
      /** Days in `analytics.daily`. Every other figure is lifetime. */
      dailyRangeDays: number;
      analytics: {
        totals: {
          viewCount: number;
          sessions: number;
          plays: number;
          uniqueViewers: number;
          avgCompletionPercent: number;
          watchTimeSeconds: number;
        };
        viewers: {
          identified: Array<{
            name: string;
            avatarUrl: string | null;
            sessions: number;
            bestCompletionPercent: number;
            lastWatchedAt: string;
          }>;
          anonymousCount: number;
        };
        [key: string]: unknown;
      };
    };

export type CaptionFormat = 'srt' | 'vtt' | 'txt';

export type RecordingKind =
  | 'bug_report'
  | 'feature_request'
  | 'product_demo'
  | 'walkthrough_tutorial'
  | 'feedback_review'
  | 'discussion_talk'
  | 'other';

export interface UploadParams {
  /** Title. Defaults to the server's "Clipy · <date>" until the AI summary names it. */
  name?: string;
  description?: string;
  recordingKind?: RecordingKind;
  /** What should have happened. Agents read it as the recording's Expected result. */
  expectedResult?: string;
  accessMode?: AccessMode;
  /** Timestamped notes; they become the transcript when the video has no speech. */
  narration?: { text?: string; notes?: Array<{ startMs: number; endMs?: number; text: string }> };
  /** Your integration's name and version, e.g. `acme-bot/1.2` (max 32 characters). */
  sourceVersion?: string;
}

export interface UploadResult {
  /** The public id: https://clipy.online/video/<publicId>. */
  publicId: string;
  shareUrl: string;
  /** Agent context (AREC markdown) for the same recording. */
  contextUrl: string;
  sizeBytes: number;
}
