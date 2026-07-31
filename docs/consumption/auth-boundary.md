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
