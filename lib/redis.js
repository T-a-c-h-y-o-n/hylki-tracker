// Upstash Redis over its REST API.
//
// No SDK on purpose: a serverless function that only speaks fetch has no
// dependency to install, no bundling to configure and no cold-start weight.
//
// Credentials are looked up under either naming the deployment might use:
//
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//       Upstash's own names, what a database made in the Upstash console
//       hands out and what Vercel injects for the newer integration.
//   KV_REST_API_URL / KV_REST_API_TOKEN
//       What Vercel's Upstash integration injects in practice — the older
//       Vercel KV names, kept because the REST endpoint behind them is the
//       same one. (REDIS_URL is deliberately ignored: it is a redis://
//       connection string for a TCP client, which a fetch-based function
//       cannot speak.)

function conf() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'no Redis credentials: set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ' +
        'or KV_REST_API_URL/KV_REST_API_TOKEN'
    );
  }
  return { url: url.replace(/\/$/, ''), token };
}

/// Run one command. Returns its result.
export async function redis(...command) {
  const { url, token } = conf();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}

/// Run several commands in one round trip. Returns their results in order.
/// A command that fails yields `null` in its slot instead of throwing, so one
/// bad command cannot lose the rest.
export async function pipeline(commands) {
  const { url, token } = conf();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(body.error || 'unexpected Upstash response');
  return body.map((entry) => (entry && entry.error ? null : entry.result));
}
