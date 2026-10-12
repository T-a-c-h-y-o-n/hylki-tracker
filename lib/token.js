// The tracking token: the piece of data that travels inside the pixel URL.
//
// It is a base64url-encoded JSON object, exactly as Mailspring does it, so the
// URL stays short and opaque and carries everything the endpoint needs to file
// an open under the right message and recipient:
//
//   { m: messageId, a: accountId, r: recipient }
//
// Nothing secret goes in here: a recipient could decode their own token and
// read nothing but their own address and an opaque message id. Everything the
// query endpoint returns is protected separately, by TRACKER_SECRET.

/// Encode the token parameters into a URL-safe string.
export function encodeToken({ messageId, accountId, recipient }) {
  const json = JSON.stringify({ m: messageId, a: accountId, r: recipient || '' });
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/// Decode a token back. Returns null when it is not one of ours, so a caller
/// can answer with something harmless instead of an error page.
export function decodeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const cleaned = token.replace(/\.png$/i, '').trim();
  if (!cleaned) return null;
  try {
    const padded = cleaned.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed.m !== 'string' || !parsed.m) return null;
    return {
      messageId: parsed.m,
      accountId: typeof parsed.a === 'string' ? parsed.a : '',
      recipient: typeof parsed.r === 'string' ? parsed.r : '',
    };
  } catch {
    return null;
  }
}
