// Upstash Redis over its REST API.
//
// No SDK on purpose: a serverless function that only speaks fetch has no
// dependency to install, no bundling to configure and no cold-start weight.
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel
// project's environment variables.

function conf() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set');
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
