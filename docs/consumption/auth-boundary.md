# The auth boundary — why a protected route answers HTTP 200

Status: recorded at the M2d review rework (2026-07-31), against FaceTheory
**v4.0.1** and lesser release **v1.5.32**.

A consumption note about one observable behaviour and the limitation behind it.
Raised in cross-client adversarial review of PR #54 (finding F4): an anonymous
request to `/l/review`, `/l/review/drafts/{id}`, or `/l/compose` — all of which
carry `requiresAuth: true` in contentus's route table — is answered with HTTP
200 and a sign-in shell, where a protected resource would ordinarily answer 401
or redirect.

## What was checked

Not a leak. `tests/ssr-review.test.mjs` pins the two properties that matter for
disclosure and both hold:

| Property                                                   | Where asserted                                            |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| the anonymous document contains no draft data              | `the review queue renders its sign-in state, not a queue` |
| the server makes no GraphQL request at all for these paths | `rendering the review queue makes no GraphQL request…`    |
| the server never sends an `Authorization` header           | `the review queue never sends an Authorization header…`   |
| the public hydration payload carries no draft              | `the hydration payload for the review queue…`             |

So the finding is about the SIGNAL the status code sends, not about access.

## Why 401 is not available at this boundary

It is not that the framework lacks a hook. FaceTheory's `renderOptions` returns
both `status` and `headers` (`src/facetheory/entry-server.ts`), and contentus
already varies `status` per route — `statusForRoute` answers 404 for an article
slug that names nothing. A 401 is one line away.

The blocker is that **the server has no credential to evaluate**. lesser's auth
contract is OAuth Authorization Code + PKCE against `auth-ui`, and the resulting
token lives in `sessionStorage` — never a cookie, by explicit invariant
(`src/lib/auth/session.ts`). Nothing about an authenticated reviewer's document
request differs from an anonymous one: same path, same headers, no cookie, no
`Authorization`. The SSR pass therefore cannot distinguish them, and a status
that claims to is a guess.

The consequence of guessing is asymmetric and lands on the wrong person. lesser
performs no SPA fallback under `/l/*`, so every cold deep link — the queue link
in a notification, a shared workspace URL, a reload — is a fresh document
request. A blanket 401 would answer "unauthorized" to the signed-in reviewer on
every one of them, for pages they are authorized to use, and their client would
then hydrate and load the queue successfully behind that 401. That trades a
false-success signal for a false-failure one, on the majority path.

What the 200 truthfully describes is the delivery of the sign-in shell, which
did succeed. The protected resource is the drafts, and those are fetched over
authenticated GraphQL, where lesser answers 401 correctly and
`failureFromErrors` classifies it as `unauthenticated`.

## What contentus changed anyway

The half of the risk that IS contentus's to close is caching and indexing: a
shared cache or a crawler treating a protected surface as ordinary public
content. Both are set at the origin — lesser does not inject headers on `/l`
routes, the origin owns them (`CLIENT_APP_GUIDE.md` → "Routing model").

`headersForRoute` in `src/facetheory/entry-server.ts` now sends, on every route
whose descriptor carries `requiresAuth: true`:

```
cache-control: no-store
x-robots-tag: noindex, nofollow
```

Asserted in `tests/ssr-review.test.mjs`, including the negative case — the
public article routes must NOT be `no-store`, or the reading surface loses its
cacheability.

## The residual, and where it is routed

**Residual:** an anonymous GET of a `requiresAuth` route still returns 200, so
uptime monitoring and log analysis cannot distinguish "protected page served its
sign-in state" from "protected page served its content". Nothing on the response
marks it as an unauthenticated render.

**Routed to:** the FaceTheory steward, via factory, as a runtime feedback item —
the `coordinate-framework-feedback` channel, not a contentus-local workaround.

**The ask:** a way for a face to mark a response as _rendered without an
evaluated session_ that is machine-readable but does not misstate the outcome to
a browser. A response header FaceTheory sets from the route descriptor (for
example `x-facetheory-auth: unevaluated`) would let monitoring and caches
distinguish the shell from the content without breaking cold deep links for
authenticated callers, and would belong to the framework rather than to each
face that has this shape.

**Not asked for:** a cookie-backed session. That would put lesser's access token
somewhere the invariant forbids and is not a trade contentus may make.

**Consequence while open:** the status codes stay as documented above, with the
reasoning recorded here rather than left as an unexplained 200.

## The OAuth core is simulacrum's, and why that had to be restored

Recorded at the M1 recovery (2026-08-05), against lesser ref
`e710ffb31a983b2ad993845dca7d3263b81de100` and simulacrum ref
`6cec1b607e48c6efc18dcd6995dbbcc2a4a5fcea`.

`src/lib/auth/session.ts` is a transplant of simulacrum's module of the same
name, not an independent implementation of the same specification. The product
design has said so since the foundation document — §3, "Copy sim's
`src/lib/auth/session.ts` + `pkce.ts` pattern unchanged" — and an earlier
contentus round did not, which broke sign-in outright.

**The instance defect the divergence collided with.** lesser generates a
`client_secret` for every OAuth client it stores, including a public one.
`CreateOAuthClientGeneric` (`pkg/storage/repositories/oauth_helpers.go:137`)
mints a secret whenever the caller supplied none, and
`createOAuthClientAndRespond` (`cmd/api/handlers/apps.go`) copies
`client.ClientSecret` into `models.AppRegistrationResponse`, where only
`omitempty` guards it. So a registration that asks for
`token_endpoint_auth_method=none` — and gets `Confidential=false` and `none`
back in the same response — is nevertheless handed a plaintext secret.

Contentus had been refusing exactly that response, on the reasoning that a
public client must never be issued a secret. The reasoning is sound and the
behaviour was wrong: it aborted every sign-in before authorization, against a
conformant instance, for a field the client simply has no business reading.
Simulacrum selects `client_id` out of that response and reads
`token_endpoint_auth_method` only to decide whether there is a usable public
client. That is now what contentus does.

**What is claimed about that secret, exactly.** `registerOAuthClient` calls
`response.json()`, so the returned `client_secret` is **transiently present in
the decoded server response** on the page's heap for the length of that call. No
browser client can make that untrue, and an earlier version of this note said
"never seen", which claimed it. What contentus does hold, and what
`tests/auth-session.test.mjs` proves by sweeping a whole sign-in rather than by
assertion, is bounded and is the part that governs behaviour: the secret is
never **selected** into the client model, never **persisted** to either storage,
never **retransmitted** on any request, never **logged**, and never placed into a
**redirect**. The sweep reads every stored value, every request body and header,
every redirect the client issues, and every console call it makes, and it is
bite-checked in both directions — a planted value in any one of those five
channels fails it.

**Where the public-client invariant actually lives.** Four places. Three are
simulacrum's: registration always asks for `token_endpoint_auth_method=none`;
the token request carries the PKCE verifier and no client authentication of any
kind; and a cached client whose method is not `none`, or which ever carried a
secret field, is discarded rather than reused. The fourth was added under
cross-client adversarial review of PR #76 (reviewing client codex, finding 1):
a **fresh registration** whose stated method is not exactly `none` is refused
before the cache write and before the authorization redirect. The cache boundary
alone cannot cover first use — the client `registerOAuthClient` returns goes
straight to the redirect without passing the cache reader — so a
`client_secret_*` registration would have been redirected against once before
anything discarded it. An absent method still reads as the `none` the request
asked for, which is simulacrum's `?? 'none'` and is unreachable against a
conformant lesser. The registration REQUEST is unchanged; this is a local
validation strengthening, not a wire-contract change.

**Routed to:** the lesser steward — returning a plaintext `client_secret` to a
public client is an instance-side defect worth closing at the source, even
though no conformant client is harmed by it. Contentus does not depend on the
fix: ignoring the field is the correct client behaviour either way, so this is
an upstream report rather than a blocker.

**Deliberate differences from simulacrum**, all local, none on the wire, each
one also stated in the module header: no `VITE_PUBLIC_OAUTH_CLIENT_ID` override
(contentus takes no config injection); no RFC 8707 `resource` parameter
(contentus is an ordinary browser app, not a remote-MCP client); sign-out
empties every `sessionStorage` key the module writes and announces itself
through `session-events`, which is this app's stand-in for sim's store
subscription; a token response without a usable `created_at`/`expires_in` is
refused rather than multiplied into `NaN`, which would otherwise produce a
session that never expires; and `returnTo` must be an app-relative path, because
contentus hands it to `window.location.replace` where sim hands it to `goto`.

Four more were added at the PR #76 review rework, all still local:

- **No refresh token is kept.** lesser issues a `refresh_token` good for seven
  days beside the one-hour access token, and permits a public-client refresh
  with that token and the public `client_id` — no secret. Simulacrum models and
  stores it. Contentus has no refresh call, no rotation, and no revocation path,
  so storing a bearer-equivalent credential nothing spends only widens what a
  transient same-origin compromise carries away. `AuthSession` has no
  `refreshToken` field and `completeLogin` does not read `refresh_token`; the
  same five-channel sweep that covers the client secret covers it (codex
  finding 2). The field returns when a scoped refresh lifecycle that consumes
  and clears it does, not ahead of it.
- **A blank `access_token` is refused and a blank `token_type` normalizes to
  `Bearer`.** A 200 carrying `access_token: ""` used to be stored and reported
  as `ok: true`, and `readSession` then rejected the session the caller had just
  been told it had. `completeLogin` and `readSession` now check the same three
  properties, and a test asserts the agreement as a property over every
  malformed token response the suite can serve (codex finding 3).
- **A non-public fresh registration is refused**, as described above (codex
  finding 1).
- **The token lifetime is checked on the instants the session carries, not on
  the seconds the response stated.** Validating `created_at` and `expires_in`
  individually and converting to milliseconds afterwards checks the wrong
  numbers: `1e308` is finite and `1e308 * 1000` is `Infinity`, which
  `JSON.stringify` writes as `null` — so `writeSession` announced `signed-in`,
  `completeLogin` answered `ok: true`, and `readSession` rejected the session a
  moment later. `createdAt` and `expiresAt` are now computed before anything is
  stored, announced, or returned, and refused unless both are safe integers:
  finite so they survive JSON, integral because rounding an instant would invent
  an expiry lesser did not state, and inside ±(2^53 − 1) because past that
  milliseconds stop being distinct. Probing this surfaced a second case of the
  same disagreement — a `created_at` already in the past is finite and exactly
  storable, and `readSession` deletes an expired session on the next read — so an
  already-elapsed lifetime is refused too, with its own message. A stated
  lifetime is never capped: shortening an absurd one would be inventing the
  lifetime this module exists to avoid inventing (codex finding 5,
  review 4870975439).

  **The two refusals do not have the same reach, and an earlier version of this
  note said they did.** The storability refusal cannot fire for the values lesser
  actually sends: `created_at` is an `int64` second and `expires_in` an `int` on
  `OAuthTokenResponse` (`cmd/api/models/oauth.go:72`), and a `time.Now().Unix()`
  stamp plus the 3600-second lifetime lands near 1.78e12 ms — eleven orders of
  magnitude inside ±(2^53 − 1). The elapsed-lifetime refusal **can** fire against
  a conformant instance, and is meant to. lesser stamps `created_at` from the
  SERVER's clock (`cmd/api/handlers/oauth.go:1025`), and the callback compares the
  instant derived from it against the BROWSER's `Date.now()`. A client clock
  running ahead of the instance by more than the stated lifetime, or a callback
  genuinely delayed past the stated expiry, therefore reaches a token that has
  really elapsed by the only clock this module can read. Refusing there is what
  keeps the callback and `readSession` from disagreeing: `ok: true` would hand
  back a session the next read deletes. "Conformant server response" and
  "synchronized clocks" are different claims, and only the first is lesser's to
  make (codex finding, review 4871214951).
