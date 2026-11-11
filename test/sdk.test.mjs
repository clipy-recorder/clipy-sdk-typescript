import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Clipy, ClipyError, UploadNotConfirmedError, verifyWebhook, WebhookVerificationError } from '../dist/index.js';

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = {}, headers = {} } = next;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

test('sends the bearer key and encodes query parameters', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { recordings: [], pagination: { page: 2, limit: 5, total: 0, totalPages: 0, hasMore: false } } },
  ]);
  const clipy = new Clipy({ apiKey: 'clipy_sk_live_test', baseUrl: 'https://example.test/', fetch });
  await clipy.recordings.list({ q: 'checkout bug', status: ['ready', 'failed'], page: 2, limit: 5 });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://example.test/api/v1/recordings');
  assert.equal(url.searchParams.get('q'), 'checkout bug');
  assert.deepEqual(url.searchParams.getAll('status'), ['ready', 'failed']);
  assert.equal(calls[0].init.headers.authorization, 'Bearer clipy_sk_live_test');
});

test('update sets or clears the expected result', async () => {
  const { fetch, calls } = fakeFetch([{ body: { recording: {} } }, { body: { recording: {} } }]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch });
  await clipy.recordings.update('abc', { expectedResult: 'Save shows Saved' });
  await clipy.recordings.update('abc', { expectedResult: null });
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { expectedResult: 'Save shows Saved' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { expectedResult: null });
});

test('retries a GET on 503 and honors Retry-After', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 503, body: { error: 'busy' }, headers: { 'retry-after': '0' } },
    { body: { recording: { id: 'abc', name: 'x' } } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  const recording = await clipy.recordings.get('abc');
  assert.equal(recording.id, 'abc');
  assert.equal(calls.length, 2);
});

test('recordings.get passes missing evidence through', async () => {
  const missingEvidence = {
    instruction: 'Where this recording lacks evidence, ask the user instead of inferring what happened across the gap.',
    gaps: [{ kind: 'cursor', reason: 'No cursor or click data.' }],
  };
  const { fetch } = fakeFetch([{ body: { recording: { id: 'abc', name: 'x', missingEvidence } } }]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  const recording = await clipy.recordings.get('abc');
  assert.deepEqual(recording.missingEvidence, missingEvidence);
});

test('does not retry a POST and surfaces the API error and code', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 409, body: { error: 'Revision changed', code: 'revision_conflict' } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  await assert.rejects(
    () => clipy.recordings.edit('abc', { removeWords: [1], dryRun: true }),
    (err) => err instanceof ClipyError && err.status === 409 && err.code === 'revision_conflict' && err.message === 'Revision changed',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { removeWords: [1], dryRun: true });
});

test('listAll walks every page', async () => {
  const page = (ids, hasMore) => ({
    body: { recordings: ids.map((id) => ({ id })), pagination: { page: 1, limit: 2, total: 3, totalPages: 2, hasMore } },
  });
  const { fetch, calls } = fakeFetch([page(['a', 'b'], true), page(['c'], false)]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  const ids = [];
  for await (const r of clipy.recordings.listAll({ limit: 2 })) ids.push(r.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(new URL(calls[1].url).searchParams.get('page'), '2');
});

test('reads AREC markdown as text and search kinds as a comma list', async () => {
  const { fetch, calls } = fakeFetch([
    { body: '# Recording', headers: { 'content-type': 'text/markdown' } },
    { body: { query: 'q', degraded: false, semantic: { status: 'ok' }, count: 0, tookMs: 1, results: [] } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  assert.equal(await clipy.contextDocuments.arec('doc1'), '# Recording');
  await clipy.search({ q: 'pricing', kinds: ['recording', 'context'] });
  assert.equal(new URL(calls[1].url).searchParams.get('kinds'), 'recording,context');
});

test('waitUntilReady polls until usable and throws on failure', async () => {
  const rec = (agentReadiness, extra = {}) => ({ body: { recording: { id: 'r', status: 'ready', stage: 'transcribing', agentReadiness, ...extra } } });
  const { fetch } = fakeFetch([rec('preparing'), rec('usable')]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  const done = await clipy.recordings.waitUntilReady('r', { pollMs: 1 });
  assert.equal(done.agentReadiness, 'usable');

  const failing = fakeFetch([rec('failed', { stage: 'failed' })]);
  const clipy2 = new Clipy({ apiKey: 'k', fetch: failing.fetch });
  await assert.rejects(() => clipy2.recordings.waitUntilReady('r', { pollMs: 1 }), ClipyError);
});

test('requires an API key', () => {
  const saved = process.env.CLIPY_API_KEY;
  delete process.env.CLIPY_API_KEY;
  assert.throws(() => new Clipy({}), /CLIPY_API_KEY/);
  if (saved !== undefined) process.env.CLIPY_API_KEY = saved;
});

// Standard Webhooks reference vector.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

test('verifyWebhook accepts the reference vector from a Headers object or a plain record', async () => {
  const now = () => Number(VECTOR.timestamp) * 1000;
  const headers = new Headers({
    'webhook-id': VECTOR.id,
    'webhook-timestamp': VECTOR.timestamp,
    'webhook-signature': `v1,bm90IGl0 ${VECTOR.signature}`,
  });
  const event = await verifyWebhook(VECTOR.body, headers, VECTOR.secret, { now });
  assert.deepEqual(event, { test: 2432232314 });
  const fromRecord = await verifyWebhook(
    VECTOR.body,
    { 'Webhook-Id': VECTOR.id, 'Webhook-Timestamp': VECTOR.timestamp, 'Webhook-Signature': VECTOR.signature },
    VECTOR.secret,
    { now },
  );
  assert.deepEqual(fromRecord, { test: 2432232314 });
});

test('verifyWebhook rejects tampering, stale timestamps and missing headers', async () => {
  const headers = { 'webhook-id': VECTOR.id, 'webhook-timestamp': VECTOR.timestamp, 'webhook-signature': VECTOR.signature };
  const now = () => Number(VECTOR.timestamp) * 1000;
  await assert.rejects(() => verifyWebhook('{"test": 1}', headers, VECTOR.secret, { now }), WebhookVerificationError);
  await assert.rejects(() => verifyWebhook(VECTOR.body, headers, VECTOR.secret), WebhookVerificationError);
  await assert.rejects(() => verifyWebhook(VECTOR.body, {}, VECTOR.secret, { now }), WebhookVerificationError);
});

test('verifyWebhook accepts a signature produced the way the Clipy server signs', async () => {
  const secret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  const body = JSON.stringify({ id: 'evt_1', type: 'recording.ready', createdAt: 'x', data: {} });
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`evt_1.${ts}.${body}`).digest('base64');
  const event = await verifyWebhook(body, { 'webhook-id': 'evt_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${mac}` }, secret);
  assert.equal(event.type, 'recording.ready');
});

test('delete repeats the id as confirmation', async () => {
  const { fetch, calls } = fakeFetch([{ body: { deleted: true, recordingId: 'abc' } }]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  await clipy.recordings.delete('abc');
  const url = new URL(calls[0].url);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(url.pathname, '/api/v1/recordings/abc');
  assert.equal(url.searchParams.get('confirm'), 'abc');
});

test('comment and reply send the API shapes; captions read text', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 201, body: { comment: { id: 'c1' } } },
    { status: 201, body: { comment: { id: 'c2' } } },
    { body: '1\n00:00:00,000 --> 00:00:01,000\nHi\n', headers: { 'content-type': 'application/x-subrip' } },
    { body: { gated: true, viewCount: 3, teaser: { sessions: 2, uniqueViewers: 1 } } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  await clipy.recordings.comment('abc', { body: 'Broken here', timestampMs: 4000 });
  await clipy.recordings.reply('abc', { body: 'Fixed', parentCommentId: 'c1' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { kind: 'comment', body: 'Broken here', timestampMs: 4000 });
  assert.deepEqual(JSON.parse(calls[1].init.body), { kind: 'reply', body: 'Fixed', parentCommentId: 'c1' });
  const srt = await clipy.recordings.captions('abc', 'srt');
  assert.match(srt, /00:00:00,000/);
  assert.equal(new URL(calls[2].url).searchParams.get('format'), 'srt');
  const analytics = await clipy.recordings.analytics('abc', { rangeDays: 7 });
  assert.equal(analytics.gated, true);
  assert.equal(new URL(calls[3].url).searchParams.get('range'), '7');
});

test('upload runs initiate, 4 MiB parts, finalize and complete', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { uploadToken: 'tok', publicId: 'new1' } },
    { body: { appended: true } },
    { body: { appended: true } },
    { body: { finalized: true } },
    { status: 201, body: { public_id: 'new1' } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch });
  const bytes = new Uint8Array(4 * 1024 * 1024 + 10);
  bytes.set([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70], 0); // ....ftyp
  const result = await clipy.recordings.upload(bytes, {
    name: 'Demo',
    recordingKind: 'bug_report',
    expectedResult: ' The total updates after the coupon ',
  });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      '/api/videos/raw-upload/initiate',
      '/api/videos/raw-upload/chunk',
      '/api/videos/raw-upload/chunk',
      '/api/videos/raw-upload/finalize',
      '/api/videos/raw-upload/complete',
    ],
  );
  assert.ok(calls[1].init.body instanceof FormData);
  assert.equal(calls[1].init.headers['content-type'], undefined, 'multipart sets its own boundary');
  assert.equal(calls[2].init.body.get('partNumber'), '2');
  const complete = JSON.parse(calls[4].init.body);
  assert.equal(complete.name, 'Demo');
  assert.equal(complete.recordingKind, 'bug_report');
  assert.equal(complete.expectedResult, 'The total updates after the coupon');
  assert.equal(result.shareUrl, 'https://example.test/video/new1');
  assert.equal(result.contextUrl, 'https://example.test/video/new1.arec');
});

test('upload sends a Blob slice by slice without reading it whole', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { uploadToken: 'tok', publicId: 'new1' } },
    { body: { appended: true } },
    { body: { appended: true } },
    { body: { finalized: true } },
    { status: 201, body: { public_id: 'new1' } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch });
  const bytes = new Uint8Array(4 * 1024 * 1024 + 10);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  const blob = new Blob([bytes]);
  blob.arrayBuffer = () => {
    throw new Error('the whole Blob was read');
  };
  const result = await clipy.recordings.upload(blob);
  const parts = [calls[1], calls[2]].map((call) => call.init.body.get('file'));
  assert.deepEqual(parts.map((part) => part.size), [4 * 1024 * 1024, 10]);
  assert.equal(parts[0].type, 'video/webm');
  assert.equal(result.sizeBytes, bytes.length);
});

test('upload names the recording when the server never confirmed its completion', async () => {
  const { fetch } = fakeFetch([
    { body: { uploadToken: 'tok', publicId: 'new1' } },
    { body: { appended: true } },
    { body: { finalized: true } },
    { status: 503, body: { error: 'waiting to be queued', code: 'queue_pending' } },
    { status: 409, body: { error: 'attached', code: 'already_attached' } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch, maxRetries: 0 });
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  await assert.rejects(
    () => clipy.recordings.upload(webm),
    (error) =>
      error instanceof UploadNotConfirmedError &&
      error.code === 'queue_pending' &&
      error.publicId === 'new1' &&
      /Do not upload again/.test(error.message),
  );
});

test('upload parts get a longer timeout than ordinary requests', async () => {
  const responses = [
    { uploadToken: 'tok', publicId: 'new1' },
    { appended: true },
    { finalized: true },
    { public_id: 'new1' },
  ];
  const fetch = async (url, init) => {
    if (String(url).endsWith('/chunk')) {
      // Slower than the client's 20 ms timeout; aborts if the part only gets that.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return new Response(JSON.stringify(responses.shift()));
  };
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch, timeoutMs: 20, maxRetries: 0 });
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const result = await clipy.recordings.upload(webm);
  assert.equal(result.publicId, 'new1');
});

test('upload refuses an unknown access mode or kind before sending anything', async () => {
  const { fetch, calls } = fakeFetch([]);
  const clipy = new Clipy({ apiKey: 'k', fetch });
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  await assert.rejects(() => clipy.recordings.upload(webm, { accessMode: 'privte' }), /accessMode must be one of/);
  await assert.rejects(() => clipy.recordings.upload(webm, { recordingKind: 'bug' }), /recordingKind must be one of/);
  assert.equal(calls.length, 0);
});

test('upload refuses non-video bytes and aborts a failed upload', async () => {
  const clipy = new Clipy({ apiKey: 'k', fetch: async () => new Response('{}') });
  await assert.rejects(() => clipy.recordings.upload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /WebM or MP4/);

  const { fetch, calls } = fakeFetch([
    { body: { uploadToken: 'tok', publicId: 'new1' } },
    { status: 422, body: { error: 'not a video' } },
    { body: { aborted: true } },
  ]);
  const failing = new Clipy({ apiKey: 'k', fetch, maxRetries: 0 });
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  await assert.rejects(() => failing.recordings.upload(webm), ClipyError);
  assert.equal(new URL(calls[2].url).pathname, '/api/videos/raw-upload/abort');
});

test('upload reports success when /complete committed but its response was lost', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { uploadToken: 'tok', publicId: 'new1' } },
    { body: { appended: true } },
    { body: { finalized: true } },
    { status: 504, body: '<html>Gateway Timeout</html>' },
    { status: 409, body: { error: 'attached', code: 'already_attached' } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch, maxRetries: 0 });
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const result = await clipy.recordings.upload(webm);
  assert.equal(result.publicId, 'new1');
  assert.equal(new URL(calls[4].url).pathname, '/api/videos/raw-upload/abort');
});

test('upload fails when the requested privacy could not be applied, even though the row exists', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { uploadToken: 'tok', publicId: 'new1' } },
    { body: { appended: true } },
    { body: { finalized: true } },
    { status: 503, body: { error: 'sharing not applied', code: 'access_mode_pending' } },
    { status: 409, body: { error: 'attached', code: 'already_attached' } },
  ]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch, maxRetries: 0 });
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  await assert.rejects(
    () => clipy.recordings.upload(webm, { accessMode: 'private' }),
    (error) =>
      error instanceof UploadNotConfirmedError && error.code === 'access_mode_pending' && error.publicId === 'new1',
  );
  // reported straight from the coded answer: no abort that could fail
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[3].url).pathname, '/api/videos/raw-upload/complete');
});

test('setAccess sends the mode, and searchDiscoverable only when given', async () => {
  const access = { mode: 'public', domains: [], grantedPeople: 0, searchDiscoverable: true };
  const { fetch, calls } = fakeFetch([{ body: { access } }, { body: { access } }]);
  const clipy = new Clipy({ apiKey: 'k', baseUrl: 'https://example.test', fetch });
  await clipy.recordings.setAccess('abc', 'private');
  const result = await clipy.recordings.setAccess('abc', 'public', { searchDiscoverable: true });
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/recordings/abc/access');
  assert.deepEqual(JSON.parse(calls[0].init.body), { mode: 'private' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { mode: 'public', searchDiscoverable: true });
  assert.equal(result.searchDiscoverable, true);
});
