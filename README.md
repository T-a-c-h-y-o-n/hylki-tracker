# hylki-tracker

A self-hosted open-tracking endpoint for the [Hylki](https://hyprlab.co/hylki/) mail
client: the piece that makes "did they open it, and when" possible without
handing anyone's mail to a cloud middleman.

It answers two questions, and nothing else:

- **The pixel.** `GET /o/<token>.png` returns a 1×1 transparent PNG and records
  one open against the message and recipient named in the token. Public by
  necessity — it is fetched by strangers' mail clients.
- **The ledger.** `GET /api/opens?ids=<messageId>[,…]` returns the open count and
  timeline for those messages. Protected by `TRACKER_SECRET`.

## How it works

The token in the pixel URL is a base64url-encoded JSON object, the same trick
Mailspring uses, so the URL stays short and carries its own filing information:

```
{ "m": "<message-id>", "a": "account-id", "r": "recipient@example.com" }
```

Nothing secret is in it: a recipient can decode their own token and learn
nothing but their own address. Everything the read side returns is protected
separately.

Per message, the store keeps:

| Key | Type | Holds |
|---|---|---|
| `ev:<messageId>` | list | open events, newest first, capped at 1000 |
| `cnt:<messageId>` | hash | opened-count per recipient |
| `meta:<messageId>` | hash | the account id |
| `msgs` | set | every message id the server has seen |

An open event carries a timestamp, the recipient, a short non-reversible tag for
the connecting address, and the user agent — never a raw IP.

## Deploying

1. **A store.** In Vercel, add an Upstash Redis database (Storage → Marketplace →
   Upstash). The free tier's 10,000 commands/day is far more than this needs;
   each open costs a handful of commands inside one pipeline round trip.
   Connecting it to the project injects `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` automatically.

2. **The secret.** Add `TRACKER_SECRET` yourself (Project → Settings →
   Environment Variables):

   ```bash
   openssl rand -base64 32
   ```

3. **The code.** Push this repository to GitHub and import it in Vercel. There is
   no build step and no dependency to install — the functions speak `fetch` to
   Upstash directly.

4. **Check it.** `/api/health` should report `{"ok":true,"redis":"ok"}`.

> **Note on the plan.** Vercel's Hobby plan is for non-commercial personal use
> only; commercial use requires Pro. If this will serve business mail, a
> Cloudflare Worker or a small VPS avoids that constraint.

## Testing

```bash
npm test                        # 31 assertions, no network, no Vercel
node test/dev-server.mjs        # then open http://localhost:3000/
```

The dev server emulates Vercel's rewrite, the `req`/`res` shape and the Redis
REST API in memory, so the whole flow — build a token, fetch the pixel, read the
opens — can be walked through in a browser before anything is deployed. Its
state is gone when it exits; point the smoke page at a real deployment to test
for real.

## What this deliberately does not do

- **No link tracking.** Wrapping links to count clicks rewrites the recipient's
  mail and breaks signatures and forwarded links. Open tracking alone leaves the
  body untouched.
- **No HTML stored.** The server never sees a message body, only a message id.
- **No bot filtering.** A mail client's image proxy counts as a fetch — see the
  caveat below.

## Caveats worth knowing before relying on it

- **Gmail and friends proxy images.** Gmail fetches the pixel through
  `googleusercontent.com` to cache it, sometimes at delivery rather than at
  open. Opens from such accounts are approximate: the count runs high, and the
  connecting address is the proxy's, not the reader's.
- **Images off means blind.** A recipient whose client blocks remote images is
  never counted. Every count is a lower bound, never a floor of truth.
- **Plain text is not tracked.** A pixel is an HTML element; plain-text mail has
  nowhere to put it. Mailspring has the same limitation.
- **Spam scoring.** A hidden pixel is a known spam signal. On bulk mail it can
  cost deliverability — worth leaving off for cold outreach and turning on for
  mail you actually want a read receipt from.

## Layout

```
api/
  o/[token].js   the pixel — never fails, never cached
  opens.js       the read side — secret-protected, ids sanitised
  health.js      is the deployment alive, can it reach its store
lib/
  redis.js       Upstash REST client, no SDK
  token.js       token encode/decode
test/
  run.mjs        the test suite
  dev-server.mjs a local Vercel stand-in
  smoke.html     the browser walkthrough
```

## Licence

AGPL-3.0-or-later, matching Hylki, so a modified version that is served over a
network must offer its source the same way.
