// End-to-end test of the tracking endpoints, with no Vercel and no Upstash:
// global fetch is stubbed with an in-memory store that answers the handful of
// Redis commands this project uses. Run it with `npm test`.

process.env.UPSTASH_REDIS_REST_URL = 'http://memory.local';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.TRACKER_SECRET = 'test-secret';

// ---------------------------------------------------------------- memory store

const store = { lists: new Map(), hashes: new Map(), sets: new Map() };

function list(key) {
  if (!store.lists.has(key)) store.lists.set(key, []);
  return store.lists.get(key);
}

function hash(key) {
  if (!store.hashes.has(key)) store.hashes.set(key, new Map());
  return store.hashes.get(key);
}

function set(key) {
  if (!store.sets.has(key)) store.sets.set(key, new Set());
  return store.sets.get(key);
}

/// Answer one Redis command the way Upstash would.
function run([command, ...args]) {
  const name = String(command).toUpperCase();
  switch (name) {
    case 'PING':
      return 'PONG';
    case 'LPUSH': {
      const target = list(args[0]);
      for (const value of args.slice(1)) target.unshift(value);
      return target.length;
    }
    case 'LRANGE': {
      const target = list(args[0]);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      const end = stop < 0 ? target.length : stop + 1;
      return target.slice(start, end);
    }
    case 'LTRIM': {
      const target = list(args[0]);
      const start = Number(args[1]);
      const stop = Number(args[2]) + 1;
      const kept = target.slice(start, stop);
      store.lists.set(args[0], kept);
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
      let added = 0;
      for (const value of args.slice(1)) {
        if (!target.has(value)) {
          target.add(value);
          added += 1;
        }
      }
      return added;
    }
    case 'SMEMBERS':
      return [...set(args[0])];
    default:
      throw new Error(`unsupported command in test: ${name}`);
  }
}

globalThis.fetch = async (url, options = {}) => {
  const commands = JSON.parse(options.body);
  const isPipeline = String(url).endsWith('/pipeline');
  const body = isPipeline
    ? commands.map((one) => {
        try {
          return { result: run(one) };
        } catch (error) {
          return { error: error.message };
        }
      })
    : (() => {
        try {
          return { result: run(commands) };
        } catch (error) {
          return { error: error.message };
        }
      })();
  return { ok: true, json: async () => body };
};

// ------------------------------------------------------------------ fake req/res

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.payload = body;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
  return res;
}

function makeReq({ query = {}, headers = {} } = {}) {
  return { query, headers, socket: { remoteAddress: '203.0.113.7' } };
}

// ------------------------------------------------------------------------ tests

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const pixel = (await import('../api/o/[token].js')).default;
const opens = (await import('../api/opens.js')).default;
const health = (await import('../api/health.js')).default;
const { encodeToken, decodeToken } = await import('../lib/token.js');

console.log('\ntoken');
const token = encodeToken({ messageId: '<abc@example.com>', accountId: '6', recipient: 'someone@example.com' });
check('round-trips', JSON.stringify(decodeToken(token)) === JSON.stringify({
  messageId: '<abc@example.com>', accountId: '6', recipient: 'someone@example.com',
}));
check('is URL-safe', /^[A-Za-z0-9_-]+$/.test(token), token);
check('accepts the .png suffix', decodeToken(`${token}.png`)?.messageId === '<abc@example.com>');
check('rejects junk', decodeToken('!!!not-base64!!!') === null);
check('rejects empty', decodeToken('') === null);

console.log('\npixel');
{
  const res = makeRes();
  await pixel(makeReq({ query: { token: `${token}.png` }, headers: { 'user-agent': 'TestMail/1.0', 'x-forwarded-for': '198.51.100.4' } }), res);
  check('answers 200', res.statusCode === 200, String(res.statusCode));
  check('is a PNG', res.headers['content-type'] === 'image/png');
  check('is never cached', String(res.headers['cache-control']).includes('no-store'));
  const sig = res.payload.subarray(0, 8);
  check('carries the PNG magic bytes', sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  check('is 1x1', res.payload.readUInt32BE(16) === 1 && res.payload.readUInt32BE(20) === 1);
}

console.log('\npixel with a bad token still returns an image');
{
  const res = makeRes();
  await pixel(makeReq({ query: { token: 'garbage' } }), res);
  check('answers 200', res.statusCode === 200);
  check('is a PNG', res.headers['content-type'] === 'image/png');
}

console.log('\npixel survives a store outage');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'upstream down' }) });
  const res = makeRes();
  await pixel(makeReq({ query: { token: `${token}.png` } }), res);
  check('still answers 200', res.statusCode === 200, String(res.statusCode));
  check('still returns the image', res.headers['content-type'] === 'image/png');
  globalThis.fetch = realFetch;
}

console.log('\nrepeated opens are counted');
{
  const counted = encodeToken({ messageId: '<counted@example.com>', accountId: '6', recipient: 'someone@example.com' });
  for (let i = 0; i < 3; i += 1) {
    const res = makeRes();
    await pixel(makeReq({ query: { token: `${counted}.png` } }), res);
  }
  const res = makeRes();
  await opens(makeReq({ query: { ids: '<counted@example.com>' }, headers: { authorization: 'Bearer test-secret' } }), res);
  const message = res.payload.messages[0];
  check('count is 3', message.count === 3, String(message.count));
  check('counts per recipient', message.counts['someone@example.com'] === 3);
  check('records the account', message.account === '6', JSON.stringify(message.account));
  check('keeps a timeline', message.events.length === 3, String(message.events.length));
  check('newest event first', message.events[0].ts >= message.events[2].ts);
  check('does not store a raw IP', !JSON.stringify(message.events).includes('198.51.100.4'));
}

console.log('\nper-recipient tokens stay apart');
{
  const other = encodeToken({ messageId: '<counted@example.com>', accountId: '6', recipient: 'second@example.com' });
  await pixel(makeReq({ query: { token: `${other}.png` } }), makeRes());
  const res = makeRes();
  await opens(makeReq({ query: { ids: '<counted@example.com>' }, headers: { authorization: 'Bearer test-secret' } }), res);
  const message = res.payload.messages[0];
  check('totals both recipients', message.count === 4, String(message.count));
  check('separates them', message.counts['second@example.com'] === 1, JSON.stringify(message.counts));
}

console.log('\nthe read side is protected');
{
  const res = makeRes();
  await opens(makeReq({ query: { ids: '<abc@example.com>' } }), res);
  check('refuses without a key', res.statusCode === 401, String(res.statusCode));

  const wrong = makeRes();
  await opens(makeReq({ query: { ids: '<abc@example.com>', key: 'nope' } }), wrong);
  check('refuses a wrong key', wrong.statusCode === 401, String(wrong.statusCode));
}

console.log('\nthe read side cannot be steered into other keys');
{
  const res = makeRes();
  await opens(makeReq({ query: { ids: 'x:y,<bad id>,ok-id' }, headers: { authorization: 'Bearer test-secret' } }), res);
  const ids = res.payload.messages.map((m) => m.id);
  check('drops ids with separators', !ids.some((id) => id.includes(':')), JSON.stringify(ids));
  check('drops ids with spaces', !ids.some((id) => id.includes(' ')), JSON.stringify(ids));
  check('keeps the clean one', ids.includes('ok-id'), JSON.stringify(ids));
}

console.log('\nunknown messages read as zero');
{
  const res = makeRes();
  await opens(makeReq({ query: { ids: 'never-sent' }, headers: { authorization: 'Bearer test-secret' } }), res);
  const message = res.payload.messages[0];
  check('count is 0', message.count === 0);
  check('no events', message.events.length === 0);
}

console.log('\nhealth');
{
  const res = makeRes();
  await health(makeReq(), res);
  check('reports ok', res.payload.ok === true && res.payload.redis === 'ok', JSON.stringify(res.payload));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'nope' }) });
  const bad = makeRes();
  await health(makeReq(), bad);
  check('reports a broken store', bad.payload.ok === false && bad.payload.redis === 'error', JSON.stringify(bad.payload));
  globalThis.fetch = realFetch;
}

console.log('\ncredentials resolve under either naming');
{
  // Vercel's Upstash integration injects the older KV_REST_API_* names, so
  // accepting only Upstash's own names would leave a connected project unable
  // to reach its database. Both are checked.
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = 'http://memory.local';
  process.env.KV_REST_API_TOKEN = 'test-token';

  const kv = makeRes();
  await health(makeReq(), kv);
  check('reaches the store via KV_REST_API_*', kv.payload.ok === true, JSON.stringify(kv.payload));

  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  const none = makeRes();
  await health(makeReq(), none);
  check('reports missing credentials honestly', none.payload.ok === false, JSON.stringify(none.payload));

  process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
