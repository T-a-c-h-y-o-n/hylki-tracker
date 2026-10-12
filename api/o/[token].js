// The tracking pixel.
//
// GET /o/:token.png  (rewritten to /api/o/:token) returns a 1x1 transparent PNG
// and files one open against the message and recipient named in the token.
//
// Two rules shape this handler:
//
//   1. It must never fail. A recipient whose mail client gets an error instead
//      of an image sees a broken picture and knows the mail is tracked. Every
//      failure below is swallowed and an image is sent regardless.
//   2. It must never be cached. A cached pixel is fetched once and every later
//      open is invisible, so the response is explicitly uncacheable.

import { pipeline } from '../../lib/redis.js';
import { decodeToken } from '../../lib/token.js';

// A 1x1 fully transparent PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// How many open events are kept per message. The count itself is separate
// (see below), so this cap only bounds the timeline the panel can show.
const MAX_EVENTS = 1000;

/// A short, non-reversible tag for the connecting address, so repeat opens
/// from one network can be told apart without storing anyone's IP.
function ipTag(req) {
  const raw =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    '';
  if (!raw) return '';
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export default async function handler(req, res) {
  // Vercel's rewrite puts the token in `token`; a direct /api/o/... call does
  // too, since the file lives under api/o/[token].js.
  const raw = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  const token = decodeToken(raw);

  if (token) {
    try {
      const event = {
        ts: Math.floor(Date.now() / 1000),
        r: token.recipient,
        ip: ipTag(req),
        ua: String(req.headers['user-agent'] || '').slice(0, 200),
      };
      await pipeline([
        ['LPUSH', `ev:${token.messageId}`, JSON.stringify(event)],
        ['LTRIM', `ev:${token.messageId}`, '0', String(MAX_EVENTS - 1)],
        ['HINCRBY', `cnt:${token.messageId}`, token.recipient || 'unknown', '1'],
        ['SADD', 'msgs', token.messageId],
        ['HSET', `meta:${token.messageId}`, 'account', token.accountId || ''],
      ]);
    } catch {
      // Swallowed on purpose: the recipient still gets an image.
    }
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(PIXEL.length));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).send(PIXEL);
}
