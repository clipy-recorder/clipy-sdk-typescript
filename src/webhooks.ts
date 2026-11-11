import type { Recording } from './types.js';

/**
 * Webhook verification for Clipy deliveries.
 *
 * Clipy signs every delivery in the Standard Webhooks format
 * (https://www.standardwebhooks.com), so any Standard Webhooks library also
 * works. This implementation uses Web Crypto only, so it runs unchanged in
 * Node 20+, Deno, Bun, Cloudflare Workers and Vercel Edge.
 *
 * Always verify against the RAW request body, before any JSON parsing.
 */

export type WebhookEventType =
  | 'recording.ready'
  | 'recording.failed'
  | 'transcript.ready'
  | 'summary.ready'
  | 'key_moments.ready'
  | 'comment.created'
  | 'recording.viewed'
  | 'recording.deleted'
  | 'webhook.test';

interface Envelope<T extends WebhookEventType, D> {
  /** Stable across retries and resends; use it to dedupe. */
  id: string;
  type: T;
  createdAt: string;
  data: D;
}

export type WebhookEvent =
  | Envelope<'recording.ready', { recording: Recording }>
  | Envelope<'recording.failed', { recording: Recording }>
  | Envelope<
      'transcript.ready',
      { recording: Recording; transcript: { segmentCount: number; empty: boolean; language: string } }
    >
  | Envelope<
      'summary.ready',
      {
        recording: Recording;
        summary: {
          tldr: string;
          keyPoints: string[];
          actionItems: string[];
          chapters: Array<{ startSec: number; label: string }>;
        };
      }
    >
  | Envelope<'key_moments.ready', { recording: Recording; keyMoments: { count: number } }>
  | Envelope<
      'comment.created',
      {
        recording: Recording;
        comment: {
          id: string;
          parentCommentId: string | null;
          body: string | null;
          timestampMs: number;
          createdAt: string;
          author: { name: string };
        };
      }
    >
  | Envelope<
      'recording.viewed',
      {
        recording: Recording;
        /** Never identifies the viewer. Sent once per viewer per recording. */
        viewer: { signedIn: boolean };
        /** Total opens so far, the owner's included. */
        viewCount: number;
      }
    >
  | Envelope<'recording.deleted', { recording: Recording; deletedAt: string }>
  | Envelope<'webhook.test', { message: string }>;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(secret: string, content: string): Promise<string> {
  if (!secret.startsWith('whsec_')) {
    throw new WebhookVerificationError('The signing secret should start with whsec_');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret.slice('whsec_'.length)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content));
  return bytesToBase64(new Uint8Array(mac));
}

/**
 * Verifies a delivery and returns the parsed event. Throws
 * WebhookVerificationError when the signature, timestamp or body is wrong;
 * respond 400 in that case and do not process the payload.
 */
export async function verifyWebhook(
  rawBody: string,
  headers: HeaderSource,
  secret: string,
  opts: { toleranceSeconds?: number; now?: () => number } = {},
): Promise<WebhookEvent> {
  const id = readHeader(headers, 'webhook-id');
  const timestamp = readHeader(headers, 'webhook-timestamp');
  const signatureHeader = readHeader(headers, 'webhook-signature');
  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header');
  }
  const ts = Number(timestamp);
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isInteger(ts) || Math.abs(now - ts) > tolerance) {
    throw new WebhookVerificationError('Timestamp is outside the allowed tolerance');
  }
  const expected = await sign(secret, `${id}.${timestamp}.${rawBody}`);
  const matched = signatureHeader.split(' ').some((candidate) => {
    const [version, value] = candidate.split(',', 2);
    return version === 'v1' && value !== undefined && timingSafeEqual(value, expected);
  });
  if (!matched) throw new WebhookVerificationError('No matching signature');
  try {
    return JSON.parse(rawBody) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('Body is not valid JSON');
  }
}
