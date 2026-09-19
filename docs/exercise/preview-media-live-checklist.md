# Exercise — preview media, the review gate, and the CSP that carries them

**Deferred to operator deploy. Recorded 2026-09-19, per the same acceptance
pattern as PR #120: named as open, with what would close each one, rather than
presented as covered.**

Three checks. They were named by the adversarial review of PR #113
(equaltoai/contentus#112, live principal review) at head `91c2f10` as not
validated anywhere in that delta, and nothing has validated them since. The
fix-up commits that added this file — `cf7b129` (delete a dead projection),
`1223fa0` (a stale version sentence in the pin narrative), `f246c13` (disclose
four transitive re-resolutions) — are code removal and narrative disclosure.
**None of them touches the preview media path, the authorization model, or the
CSP, and none of them closes a check listed here.**

Recording a deferred check is not performing it. This file exists so the gap has
an owner, an order, and a stated pass condition, instead of being rediscovered
by the next reviewer as though it were new.

## Why these are the operator's to run

Not because they are hard, but because two of the three need a deployed instance
and the third needs an install:

- `AGENTS.md` puts deploy outside the steward's lane outright — the steward
  sequences, verifies and records; it "never merges, force-pushes, deletes
  branches, deploys, signs, or mutates cloud/runtime state".
- **Deployment path is milestone zero.** The install smoke at the merged head is
  the check the whole repo's shape exists to keep green, so it is the load-bearing
  one of the three, and it is exactly the one a steward session cannot perform.
- No instance is reachable from this checkout. There is no
  `facetheory.<instance>.lesser.json` here (gitignored by design) and no
  credential; targeting is four CLI values the operator supplies.

## What is already proven, and at what level

Stated first so the size of the gap is not guessed at. At the heads named above:

- the rubric was green at the reviewed head `91c2f10` — 32 PASS, 0 FAIL, 0
  BLOCKED — and is re-run at the fix-up head before this branch is pushed, per the
  gate-before-push rule;
- `tests/review-round-trip.test.mjs` sends the exact wire documents through the
  real transport to a stub answering in lesser's contract shapes. Its own header
  draws the limit: a green run "says contentus asks the right questions and reads
  the answers correctly. It says nothing about whether a real instance answers
  them";
- `tests/review-adapters.test.mjs` drives the real adapters with `fetch` stubbed
  at the GraphQL boundary, and pins that the preview read is refused with no
  session;
- `tests/ssr-review.test.mjs` pins that the anonymous document and the public
  hydration payload stay body-free;
- `tests/review-preview-render.test.mjs` compiles and renders the shipped
  component, and shows a figure-bearing `renderedHtml` reaching the review DOM
  with `<figure>`/`<img>` intact;
- `tests/review-csp.test.mjs` drives the **built** handler
  (`build/server/handler.mjs`) for the real response header, and matches it with
  a browser-equivalent model of `img-src` source semantics.

That last line is the shape of the whole gap. Every one of those is a stub, a
source read, or a model of a browser. **No browser, no lesser, no storage
backend, no real presigned URL.** A model of CSP source matching is not a browser
deciding whether to fetch; a stub answering in lesser's shapes is not lesser
authorizing a caller.

---

## Check A — `lesser client install` smoke at the deployed head

**The milestone-zero check, and the one to run first.** Everything else presumes
a deployed client.

Run the install path per `docs/runbook.md` (authoritative for flags), then that
file's five-item post-install verification — public reading surface, auth flow,
authoring workflow, GraphQL-first, CSP. Dry-run first; it costs nothing:

```bash
pnpm run deploy -- \
  --app <instance-slug> --base-domain <base-domain> \
  --stage dev --aws-profile <profile> --dry-run
```

The v1 verification target is the **trenchcoat** dev instance. Then, beyond the
runbook's five, the review-surface additions this PR is about:

- [ ] `/l/review` and `/l/review/drafts/{id}` **server-render their chrome and
      their signed-out state**, body-free, with a strict CSP — an anonymous curl
      of either route returns no draft body and no minted URL.
- [ ] The served `content-security-policy` on the workspace route carries an
      `img-src` that includes `https:`, and **no other installed route inherits
      that widening** (the committed probe asserts both against the built
      handler; this confirms it against what the instance actually serves).
- [ ] `script-src`/`style-src` remain `'self'` on that route — the widening is
      `img-src` only.
- [ ] **A bound image is visible in the review DOM.** This is the operator
      failure behind #112: an image was bound, the review DOM carried no figure,
      and lesser-body's MCP read of the same draft showed the figure present. It
      is the outcome the whole PR exists for and it has only ever been shown
      through a rendered component in a probe, never in a browser against an
      instance.
- [ ] The browser console shows **no CSP violation** on the workspace route while
      that image loads. This is the check the CSP model cannot perform: only a
      real browser can refuse a fetch.

**A failure here routes by kind.** An install or artifact failure is local
(manifest, build, runbook). A route that serves no CSP header, or serves the
widening everywhere, is local (`src/facetheory/csp.ts`,
`src/facetheory/entry-server.ts`). An image that is bound but absent from the
rendered preview is **upstream** — lesser's `RenderDraftPreviewWithMedia` — and
is routed with `route-upstream-issue`, never patched locally.

## Check B — presigned TTL behavior

`draftPreview(id:, includeAccessUrls: true)` mints a **five-minute** presigned
storage URL per access (lesser's `IssueEditorialAccess`) and composes it into
the very `renderedHtml` the document selects. Contentus's design is to not
manage that lifetime — `src/facetheory/csp.ts` states it as "handled by not
handling it". That is a claim about a real credential's behavior and it is
untested against one.

- [ ] The image loads on a **fresh** preview load, inside the TTL.
- [ ] After the TTL has expired, **reloading the workspace obtains a fresh
      preview and a fresh URL, and the image loads again.** This is the specific
      claim the design rests on: the reviewer's recovery path is a reload, not a
      cached URL. Watch the network tab confirm a new `draftPreview` response
      with a _different_ URL rather than a re-request of the stale one.
- [ ] The expired URL **stops serving** — i.e. the TTL is real. Lesser-side, but
      it is the premise: if the URL lived forever, the "short-lived credential"
      framing everywhere in this repo would be wrong.
- [ ] **Contentus persists nothing.** No minted URL in `localStorage`,
      `sessionStorage`, a cookie, a service worker, or a cached response; none in
      the `/_facetheory/hydration` payload; none in any anonymous response. The
      probes pin the SSR and hydration halves against a stub — this confirms it
      in a browser's actual storage.
- [ ] Leaving the workspace open past the TTL produces a **broken image and a
      reload that fixes it**, not an error state the reviewer has to reason
      about. Worth recording what it looks like, since a reviewer mid-decision is
      the audience.

**A failure here is almost certainly upstream.** TTL length, minting, and
revocation are lesser's; contentus extends none of them and adds no caching. If
the reload path does not yield a fresh URL, that is a lesser finding. If a minted
URL turns up in contentus-owned storage or in an unauthenticated response, that
is local and is a **security defect, not a nit** — stop and report it rather than
finishing the checklist.

## Check C — per-viewer authorization against real lesser v1.6.28

The schema pin is **lesser v1.6.28** (`contracts/lesser/provenance.json`: tag
`v1.6.28`, ref `8f483cc5`, blob `458453ea` — machine-verified by
`scripts/verify-schema-provenance.mjs`). lesser's own rule for the preview read
is `DraftReviewForCaller` — **owner or active grantee**. Every committed probe
stubs that decision away, so the one thing nobody has checked is whether a real
instance makes it.

Three viewers, one draft that carries a bound image and a recorded generator:

- [ ] **The author (owner)** — reaches the preview, sees the figure, and sees
      their own draft's review state. Note that ownership does **not** imply a
      verdict right: lesser refuses `submitDraftReview` to an owner who is not
      the instance principal, so confirm the UI offers what lesser will accept
      and refuses what it will not, rather than offering and then reporting a
      refusal.
- [ ] **An active grantee** — reaches the preview and the figure, can record a
      verdict, and sees a stale approval demoted out of the success tone (the
      other half of #112, shipped by greater-v0.13.7's review chrome).
- [ ] **A revoked grantee** — loses access. lesser refuses the document; confirm
      contentus renders that refusal as an explained failure and **does not fall
      back to source or to a cached body**.
- [ ] **Anonymous, no session** — contentus refuses the fetch client-side before
      asking (pinned by `tests/review-adapters.test.mjs`) **and lesser refuses it
      server-side.** Both halves matter: the client-side refusal is courtesy, not
      a control, and the control has never been observed. Confirm directly against
      the instance, with no session, that the opted-in `draftPreview` read is
      refused and that **no minted URL is obtainable by an unauthorized caller** —
      a URL that leaks to a viewer who cannot read the draft is a bearer credential
      in the wrong hands.
- [ ] **A grantee of a different draft** cannot read this one by id.

**A failure here routes to lesser** — authorization is entirely lesser's, and
contentus reconstructs none of it. Record the exact operation, variables, and
lesser's response; that is what an upstream report needs.

---

## Recording the outcome

Append a **Demonstrated instance** section to this file in the shape the sibling
procedure uses (`docs/exercise/end-to-end-share-connect-observe.md`): the date,
the instance, the lesser version, the deployed contentus head SHA, who walked it,
and per check what was observed — **including anything that failed and was routed
upstream**. A check that was run and found broken is recorded as run and broken;
it is not quietly dropped from the list, and the list is not shortened to make
the record look complete.

Also record the install receipt per `docs/runbook.md`.

Until then this file is the record, and the record says **not performed**.

## Follow-ups

### The `img-src https:` widening, and the upstream ask that would narrow it

`src/facetheory/csp.ts` extends `img-src` with the `https:` scheme-source on the
review-workspace route and on no other. Before #113 that route's `img-src` was
`'self' data:`. **This is a real widening and it is recorded as one, not
presented as neutral.**

What it permits that the old policy did not: draft-authored content that survives
lesser's preview sanitizer carrying an attacker-chosen `<img src>` now auto-loads
in the reviewer's browser — a view-presence beacon to an attacker host, with the
reviewer's IP and user agent. The reviewer's browser makes the request; nothing
in contentus has to cooperate.

Why it is nonetheless correct today, and why it was not narrowed here:

- it is **required** by the feature. The presigned URL's host is the S3 regional
  endpoint — instance-specific by bucket, region-specific by construction — so no
  fixed origin can be predicted at build time, and the origin CSP is authoritative
  on `/l` routes;
- it is scoped to **one authenticated route**, `img-src` **only**, with
  `script-src`/`style-src` untouched at `'self'` and no `unsafe-*` token anywhere;
- it **appends to** FaceTheory's canonical strict policy rather than replacing it;
- it matches the scheme lesser-host's own client-delivery fallback already carries
  (`img-src 'self' data: https:`, `Override:false`).

The narrowing path is **upstream, and it is not yet filed**. Either of these
would let contentus name an origin instead of a scheme:

1. **lesser exposes the media origin in instance info.** `InstanceInfo` already
   carries `subscriptionUrl`, and `src/facetheory/entry-server.ts` already derives
   a CSP `connect-src` origin from a URL lesser itself returned rather than from
   the request — from `InstanceInfo.subscriptionUrl` on the socket routes, and
   from the agent's `mcpAccess` endpoint on the agent page. An
   `editorialMediaOrigin` beside `subscriptionUrl` would let the workspace name one
   origin, resolved at request time from the instance rather than guessed at build
   time. This is the smaller ask and the better fit: the pattern it needs is
   already in the file twice.
2. **lesser's preview sanitizer restricts non-bound external images.** The images
   this opt-in exists to serve are lesser's own bound media, minted by
   `IssueEditorialAccess` and composed by `RenderDraftPreviewWithMedia`. An
   `<img>` in a draft preview whose `src` is not a URL lesser itself minted is not
   the feature — it is smuggled content, and the sanitizer is the authority that
   should say so. This closes the beacon path for every consumer of the opt-in,
   not only contentus.

Until one of them lands, the widening stands and is disclosed. **Do not narrow
`img-src` locally without one of them**: a scheme-source that does not match the
presigned host breaks the bound image, which is the #112 failure this PR fixed.
`src/facetheory/csp.ts` was deliberately not modified by the fix-up that recorded
this.

### Not filed, and why

The upstream ask above was **not** filed as an issue against `equaltoai/lesser`
in the session that recorded it: the governed `github_*` surface on the contentus
route was unavailable (both repo MCP servers exposed OAuth authentication stubs
only — no memory tools and no GitHub tools). It is written here so the ask
survives that, and filing it is the follow-up. Use `route-upstream-issue`; ask 1
is the one to file first, since it is the smaller change and unblocks narrowing
without waiting on a sanitizer decision.
