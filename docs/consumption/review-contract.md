# Shared-draft review — what contentus consumes, and the gaps it routed

Status: recorded at M2d (2026-07-31), verified against lesser release
**v1.5.32** and the greater-components **greater-v0.12.0** release. The vendored
review chrome moved to **greater-v0.13.0** (`ce8f3d9d`) at the M6 pin bump, and
both open asks below were re-read there: both still reproduce, so each names the
release it reproduces at rather than the one it was first seen at.

The vendored tree is now at **greater-v0.13.4** and the schema pin at **lesser
v1.6.4** (2026-08-09 contract sync). Three of the routed asks below — B
(capability signal), C (typed error codes) and F (batch review projection) —
are **answered at lesser v1.6.4** and are marked closed in place; the consuming
code moved with them. Ask D (verdict control sizing) closed at greater-v0.13.4.
A and E remain open and still name the release they reproduce at.

A thin consumption note, not a redefinition of anyone's contract. It records
what contentus observed while wiring Face 2, what it decided, and what it did
not build because the contract does not currently support it.

## What contentus consumes

| Operation                                      | Used by                    | Authorization in lesser                                                |
| ---------------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `sharedDraftReviews(first, after)`             | `/review` queue            | `requireAuth`; the caller's own active grants                          |
| `myDrafts(contentType: ARTICLE, first, after)` | `/review` queue            | `requireAuth`; the caller's own drafts                                 |
| `draftReview(id)`                              | `/review/drafts/{id}` rail | `DraftReviewForCaller` — **owner or active grantee**                   |
| `draftPreview(id)`                             | workspace preview panel    | `DraftReviewForCaller` — **owner or active grantee**                   |
| `submitDraftReview(draftId, verdict, notes)`   | verdict actions            | active grant required; **owner refused** unless they are the principal |
| `publishDraft(id)`                             | publish action             | the cumulative approval gate, enforced in `DraftService`               |
| `scheduleDraft(id, scheduledAt)`               | schedule action            | `requireCMSSchedulingEnabled` + the same gate                          |

No query in `src/lib/cms/review.ts` selects `Draft.content`. Not "selects it and
declines to render it" — does not ask for it.

## The four contract facts that shaped the UI

### 1. Reading a draft and writing one are authorized differently

`draft(id)` and `updateDraft(id, …)` both resolve through
`GetDraft(ctx, username, id)` (`graph/query_resolvers_cms.go`,
`graph/mutation_resolvers_cms.go`) — **owner-only**. `draftReview(id)` and
`draftPreview(id)` resolve through `DraftReviewForCaller`
(`pkg/services/cms/draft_review.go`), which admits the owner **and** any caller
holding an active grant.

So a reviewer who is not the author has, by contract, no read of the source and
no write path at all. Their channel for changes is `submitDraftReview` with
notes, which is what the review contract is for. The workspace rail is
read-and-decide, and that is the contract's shape rather than a simplification.

### 2. An owner reviews their own draft only as the principal, and only on a grant

`DraftService.SubmitDraftReview` refuses when `caller == owner`, unless the
caller is the instance principal:

```go
if caller == owner {
    principal, err := s.instancePrincipal(ctx)
    if err != nil || principal != owner {
        return nil, errors.New("draft owner cannot review their own draft")
    }
}
if _, err := s.ActiveDraftReviewGrant(ctx, owner, draftID, caller); err != nil { … }
```

`DraftReviewForCaller` returns that self-grant explicitly — its own comment says
"Owners ordinarily have no grant, except the explicit principal-owner approval
flow for generated drafts" — so the projection's `grant` is present for exactly
this case.

Contentus therefore offers the verdict actions when `DraftReview.grant` is
present — the projection's `grant` is the **viewer's own** invitation, set from
the `g` that `DraftReviewForCaller` returned — and explains the requirement when
it is not. That is reading a field lesser publishes, not reconstructing the
policy.

**Correction recorded at the M2d rework (PR #54, finding F2).** The shipped
panel had gone further than this note and suppressed the controls for the
draft's author _even when lesser had projected an active grant_
(`canReview = Boolean(review.grant) && !isAuthor`). That is a stricter rule than
lesser's, and it removed the only path the publication gate accepts for a
principal-owned generated draft: the gate requires the instance principal's
approval on any draft recording a generator, and the principal approving their
own draft is precisely the self-grant flow above. The local gate is gone; the
decision now lives in `src/lib/review/verdict-offer.ts` and reads `grant` alone.
Contentus cannot see who the principal is, does not guess, and lets lesser
authorize.

### 2b. `myDrafts` carries no review projection at all — superseded at v1.6.4

**Superseded at lesser v1.6.4.** `myDraftReviews(first, after)` returns a full
`DraftReview` for every review assignment the caller created — ask F below,
answered. The queue's own half is now a bounded connection walk on `pageInfo`,
the per-draft `draftReview(id)` fan-out is deleted, and the `listing-only`
fallback is gone with it: every own entry renders lesser's own projection.

The historical observation stays because it shaped the code that was just
replaced: `type Draft` exposes `generatedBy` and `reviewedBy` and nothing else
about review, and lesser sets `ReviewedBy`/`ReviewStatus` together on every
`SubmitDraftReview`, so the listing alone could not distinguish "ruled on"
from "untouched". That remains true of `type Draft`; it no longer matters to
the queue, which does not read the listing.

### 3. `myDrafts` filters after it paginates

`MyDrafts` fetches a page with `ListDraftsByAuthorPaginated` and only then drops
entries whose `contentType` or `status` do not match; `totalCount` is the length
of the filtered page, not of the set. An empty page therefore does not mean an
empty result, and `hasNextPage` still refers to the unfiltered walk.

The queue walks a bounded number of pages and, when more remain, says "none in
what was scanned" rather than "none". The distinction is the difference between
a true statement and a false one.

### 4. The publication gate is cumulative, and v1.6.4 serves lesser's own evaluation

**Updated at lesser v1.6.4.** `PublishDraft` still requires unanimous approval
from every reviewer holding an active grant, and — for any draft that records
a generator — the instance principal's approval as well. What changed is that
lesser now serves its own evaluation of that rule: `DraftReview.publishEligibility
{ eligible blockingReasons reviewersApproved principalApprovalRequired
principalApproved }`, with `contentHash`/`revision` binding it to exact draft
content and `verdicts[].current/stale` marking verdicts a later edit
invalidated.

Contentus still never evaluates the gate itself — it READS lesser's. The
publish action is disabled on a served `eligible: false` with
`blockingReasons` rendered verbatim, and the mutation refusal remains the
final word (an eligibility read can be stale between load and click). The
vendored `describeApprovalRequirement` states which rules are in force;
`resolveReviewState` renders `reviewStatus` as **latest activity** with
`REVIEW_STATE_QUALIFIER` beside it, deliberately remaining an activity badge
now that the canonical gate lives in `publishEligibility`.

## Upstream asks, routed rather than worked around

### A. `Editor.Root` cannot be consumed by a renderer-authority-honoring client

**Where:** `equaltoai/greater-components`, blog face,
`packages/faces/blog/src/components/Editor/Root.svelte`.

The component's preview pane only renders when `config.mode === 'split'`, but
the import that supplies it is unconditional and top-level:

```svelte
import { MarkdownRenderer } from '…/content';
```

`MarkdownRenderer.svelte` in turn imports `remark-parse`, `remark-gfm`, and
`remark-rehype`. Because the import is static, the module graph is resolved
before tree-shaking, so a consumer that never sets `mode: 'split'` still pulls
the client-side Markdown renderer into its bundle. Contentus does not install
that chain — its renderer-authority audit forbids it as a direct dependency —
so the Editor compound cannot be imported at all.

**Ask:** make the preview pane's renderer a dynamic import, or move the pane
into a separate component that consumers opt into. Either shape lets a client
that honors lesser's renderer authority use the editor and toolbar.

**Consequence while open:** Face 2's rail ships without an editor. Sub-issue #11
named `Editor.Root` as a component to reuse "where they fit"; it does not fit,
and fact 1 above means it would only ever have applied to the viewer's own
drafts in any case.

### B. No readable capability signal for the CMS mode gates

**CLOSED at lesser v1.6.4 (#1348).** `InstanceInfo.cmsFeatures { longForm
drafts revisions scheduling series categories }` is the public,
unauthenticated-safe capability field this ask proposed. Contentus reads it:
the schedule control initializes from `cmsFeatures.scheduling` (unavailable on
a served `false`, with no `scheduleDraft` attempted), and the typed
`FEATURE_DISABLED` refusal remains the final word against a stale read.

**Where:** `equaltoai/lesser`, GraphQL contract.

### C. CMS errors carry no machine-readable code

**CLOSED at lesser v1.6.4 (e93388ab7).** CMS errors now carry
`extensions.code` — `FEATURE_DISABLED`, `NOT_FOUND`, `FORBIDDEN`,
`VALIDATION`, `UNAUTHENTICATED` — and `failureFromErrors` matches the code
first. The message-substring matching stays as the fallback for pre-v1.6.4
instances, and it still does the work for the approval-gate refusal, which
lesser's classifier tags `INTERNAL_ERROR` (unmapped) — the `gated`
classification therefore still rides the message text there, by examination
of the upstream classifier rather than by accident. The classification
remains presentational: a miss degrades to a plainer message, never to a
wrong permission decision.

**Where:** `equaltoai/lesser`, CMS resolvers.

### D. `Review.VerdictActions` sizes its controls below the touch floor

**CLOSED at greater-v0.13.4 (upstream #1018).** Every control the component
renders — both verdict buttons, the dialog's Cancel and confirm — is now
`size="lg"`, and the vendored primitives theme sizes that variant
`min-height: 3rem` (48px), above the 44px floor natively. The sizing bridge in
`src/lib/brand/bridge.css` is deleted per its own swap-to-vendored header, and
`tests/mobile-chrome.test.mjs` now pins the native floor: the component must
render `size="lg"` (never `size="sm"`) and the `gr-button--lg` variant must
stay at or above 3rem.

~~**Where:** `equaltoai/greater-components`, `review` registry entry,~~
~~`Review/VerdictActions.svelte` (first seen at greater-v0.12.0; still present at~~
~~the current **greater-v0.13.1** pin, where every control is `size="sm"` — the~~
~~component's bytes are unchanged from 0.13.0).~~

Every control the component renders is `size="sm"` — both verdict buttons, both
dialog buttons, and the dialog's close control — and the vendored primitives
theme sizes that variant `min-height: 2rem` (32px). On a phone, the two
decisions a reviewer makes are the smallest targets on the screen. Product
design §4 sets a 44px floor, and contentus's own controls beside them
(`.contentus-review-publish__*`, `.contentus-review-segmented__option`) meet it.

**Ask:** raise the review chrome's controls to a 44px minimum, or expose `size`
as a prop on `VerdictActions` so a consumer can. The buttons are a decision
surface, not a toolbar.

**What contentus did while this was open:** a **sizing bridge** in
`src/lib/brand/bridge.css` raised the vendored selectors to 44px, appearance
only, the component never edited. The upstream fix landed the first half of
the ask (`size="lg"` across the chrome), so the bridge is deleted and the
probes assert the native floor instead.

### E. `resolveReviewState` renders an absent projection as a decided absence

**Where:** `equaltoai/greater-components`, `review` registry entry,
`Review/state.ts` (first seen at greater-v0.12.0; still present at the current
**greater-v0.13.1** pin, byte-identical to 0.13.0).

With no `reviewStatus` and an empty `verdicts`, `resolveReviewState` returns the
definite label `"No review activity recorded"` with `source: 'none'`. That is
correct for a `DraftReview`, which carries both fields — their emptiness is an
answer. It is wrong for any partial projection, and `DraftReviewData` is
explicitly documented as a view model that consumers may fill from partial
query selections. The chrome has no way to say "not known".

**Ask:** a fourth state — `source: 'unknown'` with a neutral label — for a
projection that did not carry the review fields, so a consumer can distinguish
"nobody has reviewed this" from "I was not told".

**What contentus did while this is open:** the queue fetches the full projection
(fact 2b above) so the vendored badge is lesser's own answer, and renders its own
minimal card for the entries where that projection did not arrive. No vendored
file is edited.

### F. No batch review projection for a caller's own drafts

**CLOSED at lesser v1.6.4 (5d5a278a2).** `myDraftReviews(first, after)` is the
connection this ask proposed, returning a full `DraftReview` per assignment
the caller created. The queue consumes it as a bounded `pageInfo` walk; the
per-draft `draftReview(id)` fan-out, the `listing-only` fallback, and the
`myDrafts` listing read are deleted from the queue path.

**Where:** `equaltoai/lesser`, GraphQL contract.

### G. `DraftReview` carries no `actedBy` carrier for the review surface

**Where:** `equaltoai/lesser`, GraphQL contract.

lesser v1.6.5's act-as contract (`docs/contracts/agent-share-act-as.md`)
names `Draft.actedBy` and `Article.actedBy` as the CMS caller-attribution
carriers — the v1.6.4→v1.6.5 schema delta is exactly those two fields.
`DraftReview` — the projection the review queue and the review workspace
consume, and the shape every act-as-enabled review operation returns
(`sharedDraftReviews`, `draftReview`, `submitDraftReview`) — has none. A
grantee acting as an agent therefore sees the agent in the verdict's
`reviewer` position and the real caller nowhere in the review projection; the
caller's attribution lives in the audit event
(`cms.draft.review_verdict` metadata) and in `Draft.actedBy`, which is
owner-only-readable (`draft(id)` resolves through `GetDraft`, and `Draft` is
not selected on the queue path).

**Ask:** expose the real-caller attribution on the review projection — a
`DraftReview.actedBy` (or per-verdict `actedBy` on `DraftReviewVerdictRecord`)
resolving the actor under whose grant the write was performed — so a
grantee-facing review surface can show who actually acted, not only which
agent they acted as.

**What contentus did while this is open:** phase 5 displays the carrier that
exists — `Draft.actedBy`, read through a contentus-owned `draft(id)` document
on the workspace (owner-only, and agent-scoped under act-as) and rendered as
a contentus-owned attribution row beside the vendored
`Review.AttributionStrip`, which cannot be edited and whose `DraftReviewData`
input has no field to carry it. The queue shows no per-draft caller
attribution until this ask lands; the act-as banner (phase 5) is what makes
the acting identity legible there.

**Escalated 2026-08-13:** routed to `factory.equaltoai@theorymcp.ai`
(delivery-8d8cae4ac3204cdc) as an active lesser need, alongside the agent
ownership-signal need.

## M2d.5 — the completion-gate round trip, and what was actually verified

The operator's completion gate is: articles sharable as drafts for review, and
review possible through **both** contentus and MCP. Three things were checked,
and they are not the same kind of evidence. Saying which is which is the point
of this section.

### 1. Contentus's half of the round trip — VERIFIED, against shipped code

`tests/review-round-trip.test.mjs` walks share → queue → `draftPreview` →
verdict → gated publish. Each step sends one of the exact documents
`review-contract.ts` exports and feeds the answer through the exact projections
the routes use, so it is evidence about the shipped consumption of the contract.

Recorded results:

| Step              | Asserted                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| share → queue     | the shared draft sorts above the viewer's own agent drafts; the viewer's grant is carried                |
| `draftPreview`    | the body is lesser's rendered HTML; no Markdown syntax reaches the reader; no document selects `content` |
| preview failure   | partial output is dropped, lesser's errors are shown, nothing is rendered in its place                   |
| verdict           | the server's `DraftReview` replaces the local copy; the draft is still `DRAFT`                           |
| **gated publish** | the principal-approval refusal is classified `gated` and lesser's wording is verbatim                    |
| publish           | lesser's assigned slug and Article identity are what the UI links to                                     |

The gate step asserts the **refusal** as its pass condition. A draft that
published without approval would fail the suite, which is the right way round
for a face whose product property is that publication is gated.

**What this is not.** The stand-in is not lesser. It does not enforce the gate,
authorize a grant, or render Markdown. A green run says contentus asks the right
questions and reads the answers correctly — nothing about whether a live
instance answers them.

### 2. MCP parity — VERIFIED AS A CONTRACT PROPERTY, not behaviourally

lesser-body's M2b surface (`article_draft_review_submit`,
`article_draft_review_read`, `article_draft_review_verdict`,
`article_draft_publish`, merged as #507 at `16c9359`) is documented as calling
the **same Lesser CMS operations** this face sends. Parity is therefore a
property of the shared contract rather than of two implementations happening to
agree, and the half this repository can check is checked: contentus drives
exactly `sharedDraftReviews`, `draftReview`, `draft`, `myDrafts`,
`draftPreview`, `submitDraftReview`, `publishDraft`, `scheduleDraft` — and
nothing invented alongside them.

**Not verified:** the same draft moving through both surfaces in one session.
That needs a live instance and a reachable Body endpoint. See below.

### 3. Live instance round trip on `trenchcoat` — PARTLY RUN

> **CORRECTED 2026-08-06.** The section below concluded there was "no verified
> address to reach". That conclusion is **false and was false when relied on**.
> The instance is `https://dev.trenchcoat.greater.website` — a different hostname
> from the two tried in July — and it answers anonymous GraphQL today. The 2026-07-31
> non-gating ruling also predates issue #74's acceptance contract and cannot be
> cited to close it.
>
> Anonymous reads are now verified and reproducible in one command; see
> [docs/consumption/graphql-contract.md](graphql-contract.md#evidence-from-a-real-instance)
> and `scripts/probe-live-contract.mjs`. All three public article documents are
> accepted, and the instance refuses `Actor.avatarUrl` by name.
>
> Still absent: **authenticated** index/detail reads, and any evidence at all
> about the reviewed build — PR #77 is neither merged nor deployed, so the
> artifact serving `/l/` is an older one. Both remaining halves are operator
> steps; this steward holds no token and no deploy authority.
>
> One live mismatch is recorded rather than disguised: the deployed SSR reports
> `unavailable: { reason: "transport" }` for the index and 404s the detail route
> while the same anonymous query succeeds from outside. That points at the
> deployed artifact's edge configuration (`x-lesser-forwarded-host`, which
> `src/lib/cms/origin.ts` fails closed without), not at this PR's diff.

The July attempts are kept below because the addresses they rule out are still
useful, and because a record that quietly replaced its own conclusions would be
worth less than one that shows them being corrected.

What was attempted then and what it returned:

| Attempt                                      | Result                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `https://trenchcoat.lesser.host/api/graphql` | DNS does not resolve                                                  |
| `https://lab.lesser.host/api/graphql`        | HTTP 404 — not the instance's GraphQL surface                         |
| lesser-body MCP `article_draft_*` tools      | no such endpoint is connected to this session                         |
| `lesser client install` to the dev instance  | operator-only; the steward does not run installs on its own authority |

The runbook's config-free deploy section derives a stage origin from the
operator-supplied `--stage` and `--base-domain` values for verification only;
it deliberately keeps no instance registry. M2b also landed on lesser-body's
`staging` rather than `main`, so the parity surface is not deployed anywhere
this session could reach.

**None of this is evidence that the round trip fails.** It is the absence of
evidence, and it is recorded as such. The live round trip is an operator-run
step: install contentus to the dev instance, then drive one draft through
contentus and through the Body tools. Its outcome belongs on issue #14 when it
happens.

**The lesson worth keeping.** "No address resolved" was recorded as a fact and
then read, months later, as "no instance exists". An absence of evidence decays
into a claim unless something re-runs it, which is why the replacement is a
script anyone can run in one line rather than a paragraph anyone can cite.

## What contentus refused to do

- Render Markdown client-side, anywhere, for any preview.
- Display `Draft.content` — the preview is `draftPreview.renderedHtml` or an
  explained failure with lesser's own deterministic errors.
- Offer verdict actions from the queue, which would let an approval be given
  without reading the rendered draft.
- Compute the approval gate, gate the publish button on that computation, or
  predict the `reviewStatus` a verdict will produce.
- Auto-publish anything, under any condition.
