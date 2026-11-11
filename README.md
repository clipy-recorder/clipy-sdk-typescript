# @clipy/sdk

The official TypeScript SDK for [Clipy](https://clipy.online). Read your recordings, transcripts, AI summaries and key moments from code, and verify Clipy webhook deliveries.

- No runtime dependencies. Uses the platform `fetch` and Web Crypto.
- Runs on Node 20+, Deno, Bun, Cloudflare Workers and Vercel Edge.
- Fully typed responses that match the wire format of the [REST API](https://clipy.online/docs/api).

## Install

```sh
npm install @clipy/sdk
```

## Authenticate

Create a key at [Settings, API keys](https://clipy.online/settings/api-keys) and pass it in, or set `CLIPY_API_KEY`.

```ts
import { Clipy } from '@clipy/sdk';

const clipy = new Clipy({ apiKey: process.env.CLIPY_API_KEY });
```

Grant only the scopes you need: `recordings:read` for reading, `recordings:write` to rename, retitle, re-share, organize or cut, and `ingest` to replace transcripts or manage imported context.

## Read a recording

```ts
const recording = await clipy.recordings.get('abc123xyz');

const { transcript } = await clipy.recordings.transcript(recording.id);
const { summary } = await clipy.recordings.summary(recording.id);
const { moments } = await clipy.recordings.keyMoments(recording.id);

console.log(summary?.tldr);
for (const moment of moments) {
  console.log(moment.timeLabel, moment.caption, moment.frameUrl);
}
```

Artifacts that are still being generated come back with `status: 'pending'` and a `hint`, not an error. In a script, wait for them:

```ts
await clipy.recordings.waitUntilReady('abc123xyz', { until: 'usable' });
```

## List and search

```ts
for await (const recording of clipy.recordings.listAll({ status: ['ready'] })) {
  console.log(recording.name, recording.webUrl);
}

const { results, degraded } = await clipy.search({ q: 'stripe webhook', kinds: ['recording'] });
```

When `degraded` is true the semantic index was unavailable and the results are keyword matches only.

## Change things

```ts
await clipy.recordings.update(id, { name: 'Checkout total is wrong' });
await clipy.recordings.setAccess(id, 'restricted');
// Public, and listed in search results:
await clipy.recordings.setAccess(id, 'public', { searchDiscoverable: true });
await clipy.recordings.organize(id, { addTags: ['bug'], folderId: null });

// Comment as yourself, read the thread, read viewer analytics.
await clipy.recordings.comment(id, { body: 'Fixed in #12', timestampMs: 65_000 });
const { comments } = await clipy.recordings.comments(id);
const analytics = await clipy.recordings.analytics(id, { rangeDays: 30 });

// Captions as SubRip, WebVTT or plain text.
const srt = await clipy.recordings.captions(id, 'srt');

// Permanent. Needs a key with recordings:delete.
await clipy.recordings.delete(id);

// Cut filler words: always preview first.
const preview = await clipy.recordings.edit(id, { removeFillerWords: true, dryRun: true });
console.log(preview.removedWords);
await clipy.recordings.edit(id, { removeFillerWords: true, expectedRevision: preview.revision });
```

## Upload a video

Needs a key with `ingest`. WebM and MP4 (QuickTime `.mov` included); the upload counts toward the account's recording allowance. Every step is retried safely and a failed upload is cleaned up.

```ts
import { readFile } from 'node:fs/promises';

const { publicId, shareUrl } = await clipy.recordings.upload(await readFile('repro.mp4'), {
  name: 'Checkout total is wrong',
  recordingKind: 'bug_report',
  accessMode: 'private',
});
await clipy.recordings.waitUntilReady(publicId);
```

## Errors

Every non-2xx response throws a `ClipyError` with `status`, the API's `message`, an optional machine-readable `code` (such as `revision_conflict`) and the parsed `body`. Reads are retried automatically on 429, 502, 503 and 504, honoring `Retry-After`. Writes are never retried silently unless they are idempotent.

## Webhooks

Add an endpoint at [Settings, Webhooks](https://clipy.online/settings/webhooks), copy its signing secret, and verify every delivery against the raw body before trusting it:

```ts
import { verifyWebhook, WebhookVerificationError } from '@clipy/sdk';

export async function POST(request: Request) {
  const body = await request.text();
  try {
    const event = await verifyWebhook(body, request.headers, process.env.CLIPY_WEBHOOK_SECRET!);
    switch (event.type) {
      case 'summary.ready':
        console.log(event.data.recording.name, event.data.summary.tldr);
        break;
      case 'comment.created':
        console.log(`${event.data.comment.author.name}: ${event.data.comment.body}`);
        break;
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response('bad signature', { status: 400 });
    throw error;
  }
}
```

Respond with any 2xx within 10 seconds. Clipy retries failures for about a day, and deliveries can repeat, so dedupe on `event.id`. The full event list and payloads are in the [webhooks guide](https://clipy.online/docs/webhooks).

## License

MIT
