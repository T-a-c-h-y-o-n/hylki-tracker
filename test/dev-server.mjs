// A local stand-in for Vercel, so the endpoints can be exercised over real HTTP
// before anything is deployed. It serves the same handlers through the same
// rewrite (/o/:token → the pixel) and keeps its state in memory.
//
//   node test/dev-server.mjs
//   open http://localhost:3000/  — the smoke-test page
//
// Not for production: one process, no Redis, and the store is gone when it exits.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

process.env.UPSTASH_REDIS_REST_URL = 'http://memory.local';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'dev-token';
process.env.TRACKER_SECRET ||= 'dev-secret';

// ------------------------------------------------------ in-memory Redis shim

const lists = new Map();
const hashes = new Map();
const sets = new Map();

const list = (k) => (lists.has(k) ? lists.get(k) : (lists.set(k, []), lists.get(k)));
const hash = (k) => (hashes.has(k) ? hashes.get(k) : (hashes.set(k, new Map()), hashes.get(k)));
const set = (k) => (sets.has(k) ? sets.get(k) : (sets.set(k, new Set()), sets.get(k)));

function run([command, ...args]) {
  switch (String(command).toUpperCase()) {
    case 'PING':
      return 'PONG';
    case 'LPUSH': {
      const target = list(args[0]);
      for (const value of args.slice(1)) target.unshift(value);
      return target.length;
    }
    case 'LRANGE': {
      const target = list(args[0]);
      const stop = Number(args[2]) < 0 ? target.length : Number(args[2]) + 1;
      return target.slice(Number(args[1]), stop);
    }
    case 'LTRIM': {
      lists.set(args[0], list(args[0]).slice(Number(args[1]), Number(args[2]) + 1));
      return 'OK';
    }
    case 'HINCRBY': {
      const target = hash(args[0]);
      const next = (Number(target.get(args[1])) || 0) + Number(args[2]);
      target.set(args[1], String(next));
      return next;
    }
    case 'HSET': {
      const target = hash(args[0]);
      for (let i = 1; i + 1 < args.length; i += 2) target.set(args[i], args[i + 1]);
      return 'OK';
    }
    case 'HGET':
      return hash(args[0]).get(args[1]) ?? null;
    case 'HGETALL': {
      const flat = [];
      for (const [field, value] of hash(args[0])) flat.push(field, value);
      return flat;
    }
    case 'SADD': {
      const target = set(args[0]);
      for (const value of args.slice(1)) target.add(value);
      return target.size;
    }
    case 'SMEMBERS':
      return [...set(args[0])];
    default:
      throw new Error(`unsupported command: ${command}`);
  }
}

globalThis.fetch = async (url, options = {}) => {
  const isPipeline = String(url).endsWith('/pipeline');
  const body = isPipeline
    ? JSON.parse(options.body).map((one) => {
        try {
          return { result: run(one) };
        } catch (error) {
          return { error: error.message };
        }
      })
    : (() => {
        try {
          return { result: run(JSON.parse(options.body)) };
        } catch (error) {
          return { error: error.message };
        }
      })();
  return { ok: true, json: async () => body };
};

// ------------------------------------------------------------------ handlers

const pixel = (await import('../api/o/[token].js')).default;
const opens = (await import('../api/opens.js')).default;
const health = (await import('../api/health.js')).default;

/// Vercel's res object, near enough for these handlers.
function makeRes(res) {
  let status = 200;
  const headers = {};
  return {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      status = code;
      return this;
    },
    send(body) {
      res.writeHead(status, headers);
      res.end(body);
    },
    json(body) {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  };
}

const PAGE = readFileSync(join(here, 'smoke.html'));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const bare = { query, headers: req.headers, socket: req.socket };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  // The same rewrite vercel.json applies.
  const o = url.pathname.match(/^\/o\/(.+)$/);
  if (o) {
    await pixel({ ...bare, query: { ...query, token: decodeURIComponent(o[1]) } }, makeRes(res));
    return;
  }
  if (url.pathname === '/api/opens') {
    await opens(bare, makeRes(res));
    return;
  }
  if (url.pathname === '/api/health') {
    await health(bare, makeRes(res));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`hylki-tracker dev server on http://localhost:${port}`);
  console.log(`  smoke page : http://localhost:${port}/`);
  console.log(`  pixel      : http://localhost:${port}/o/<token>.png`);
  console.log(`  opens      : http://localhost:${port}/api/opens?ids=<id>&key=${process.env.TRACKER_SECRET}`);
  console.log(`  health     : http://localhost:${port}/api/health`);
});
