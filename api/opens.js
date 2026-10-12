// The read side, for the mail client.
//
// GET /api/opens?ids=<messageId>,<messageId>...
//   Authorization: Bearer <TRACKER_SECRET>
//
// Answers with the open count and timeline for each requested message. This
// endpoint is secret-protected: the pixel has to be public, but who opened
// which mail is nobody else's business.

import { redis, pipeline } from '../lib/redis.js';

/// Constant-time-ish comparison, so a wrong key cannot be probed by timing.
function sameSecret(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/// The secret from an Authorization header or a `key` query parameter.
function suppliedSecret(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const key = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
  return typeof key === 'string' ? key : '';
}

function parseIds(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  for (const item of list) {
    const id = String(item).trim();
    // Message ids reach us from a client, so they are only ever used as a
    // suffix on a namespaced key — but a separator in one would let a caller
    // read another message's events, so it is refused outright.
    if (id && id.length <= 256 && !/[\s:*]/.test(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 200);
}

export default async function handler(req, res) {
  // An unconfigured deployment is an operator problem, not an intruder, and
  // saying so costs nothing: it keeps "no secret was ever set" from looking
  // exactly like "a wrong secret was supplied" while somebody is wiring this
  // up. Nothing about the secret itself is revealed either way.
  if (!process.env.TRACKER_SECRET) {
    res.status(503).json({
      error: 'not_configured',
      detail: 'TRACKER_SECRET is not set on this deployment',
    });
    return;
  }

  if (!sameSecret(suppliedSecret(req), process.env.TRACKER_SECRET)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const ids = parseIds(req.query.ids);
  if (ids.length === 0) {
    // No ids: report what the server has seen, newest messages first.
    const known = (await redis('SMEMBERS', 'msgs')) || [];
    res.status(200).json({ messages: [], known: known.slice(0, 500) });
    return;
  }

  const commands = [];
  for (const id of ids) {
    commands.push(['HGETALL', `cnt:${id}`]);
    commands.push(['LRANGE', `ev:${id}`, '0', '199']);
    commands.push(['HGET', `meta:${id}`, 'account']);
  }

  const results = await pipeline(commands);
  const messages = [];

  for (let i = 0; i < ids.length; i += 1) {
    const perRecipient = results[i * 3] || {};
    const rawEvents = results[i * 3 + 1] || [];
    const account = results[i * 3 + 2] || '';

    // Upstash answers HGETALL as a flat [field, value, field, value, ...] array.
    const counts = {};
    let total = 0;
    if (Array.isArray(perRecipient)) {
      for (let j = 0; j + 1 < perRecipient.length; j += 2) {
        const n = Number(perRecipient[j + 1]) || 0;
        counts[perRecipient[j]] = n;
        total += n;
      }
    }

    const events = [];
    for (const raw of rawEvents) {
      try {
        events.push(JSON.parse(raw));
      } catch {
        // A malformed row is skipped rather than failing the whole answer.
      }
    }
    events.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    messages.push({
      id: ids[i],
      account,
      count: total,
      counts,
      first: events.length ? events[events.length - 1].ts : null,
      last: events.length ? events[0].ts : null,
      events,
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ messages });
}
