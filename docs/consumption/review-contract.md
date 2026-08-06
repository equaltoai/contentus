# Shared-draft review — what contentus consumes, and the gaps it routed

Status: recorded at M2d (2026-07-31), verified against lesser release
**v1.5.32** and the greater-components **greater-v0.12.0** release. The vendored
review chrome moved to **greater-v0.13.0** (`ce8f3d9d`) at the M6 pin bump, and
both open asks below were re-read there: both still reproduce, so each names the
release it reproduces at rather than the one it was first seen at.

The vendored tree is now at **greater-v0.13.1** (`fb6ee927`), bumped at M2 for
`greater update`'s new obsolete-file pruning. That release changed the CLI and
nothing else: comparing `ce8f3d9d…fb6ee927` upstream shows no file under
`packages/*/src` outside `packages/cli` moved, and re-running the CLI over this
consumer rewrote 104 managed files to byte-identical content. So every
observation below reproduces at 0.13.1 unchanged — stated because "still
reproduces" is worth nothing when nobody checked whether the subject moved.

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

### 2b. `myDrafts` carries no review projection at all

`type Draft` (`graph/phase1.graphql`) exposes `generatedBy` and `reviewedBy` and
**nothing else about review**: no `reviewStatus`, no `editorNotes`, no `grant`,
no verdict history. `type DraftReview` carries all five.

lesser sets `Draft.ReviewedBy` and `Draft.ReviewStatus` together, on every
`SubmitDraftReview` (`draft_review.go`). So a draft a reviewer has already ruled
on comes back from the listing with a reviewer and no verdicts — indistinguishable,
in the fields the queue actually reads, from one nobody has touched.

The queue therefore loads `draftReview(id)` for each of the viewer's own
agent-generated drafts. `DraftReviewForCaller` authorizes it for the **owner** as
well as for an active grantee, so the viewer is entitled to every one of them,
and asking is reading the contract rather than working around it. A draft whose
projection does not arrive keeps its listing shape, is marked `listing-only`, and
is rendered as an unknown review state — never as a decided absence. See upstream
ask E below for the chrome half of this, and ask F for the fan-out.

### 3. `myDrafts` filters after it paginates

`MyDrafts` fetches a page with `ListDraftsByAuthorPaginated` and only then drops
entries whose `contentType` or `status` do not match; `totalCount` is the length
of the filtered page, not of the set. An empty page therefore does not mean an
empty result, and `hasNextPage` still refers to the unfiltered walk.

The queue walks a bounded number of pages and, when more remain, says "none in
what was scanned" rather than "none". The distinction is the difference between
a true statement and a false one.

### 4. The publication gate is cumulative, and the client cannot compute it

`PublishDraft` requires unanimous approval from every reviewer holding an active
grant, and — for any draft that records a generator — the instance principal's
approval as well. Both, not either.

Contentus never evaluates that. The vendored `describeApprovalRequirement`
states which rules are in force; `resolveReviewState` renders `reviewStatus` as
**latest activity** with `REVIEW_STATE_QUALIFIER` beside it; and publish
enablement comes from lesser's answer to the mutation. The inputs the rule needs
— the active-grant set, the principal's identity — are not in the projection, so
any client-side "3 of 3" would be invented.

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

**Where:** `equaltoai/lesser`, GraphQL contract.

`scheduleDraft` sits behind `requireCMSSchedulingEnabled`, and `revisions` /
`restoreRevision` behind `requireCMSRevisionsEnabled`, but the public schema
exposes no field a client can read to discover which are on — the flags live on
the admin-scoped `AdminInstanceConfig` / `InstanceConfigFeature`.

Product design §5 asks for mode-gated features to be hidden unless enabled. A
client cannot do that without a signal, so contentus offers the control, treats
the feature-gate error as a product state, and stops offering it for the rest of
the session.

**Ask:** a public, unauthenticated-safe capability field — for example
`instanceInfo.cmsFeatures { longForm scheduling revisions }`.

### C. CMS errors carry no machine-readable code

**Where:** `equaltoai/lesser`, CMS resolvers.

The CMS resolvers return bare `errors.New(...)` values with no
`extensions.code`, so a client distinguishing "the gate refused" from "the draft
is gone" from "the instance is unwell" has only the message text to go on.
`src/lib/cms/review.ts` classifies on message substrings and says so in a
comment; the classification is presentational, so a miss degrades to a plainer
message rather than to a wrong permission decision.

**Ask:** an `extensions.code` on CMS errors — at minimum for the approval-gate
refusal, feature-gate refusal, and not-found/forbidden.

### D. `Review.VerdictActions` sizes its controls below the touch floor

**Where:** `equaltoai/greater-components`, `review` registry entry,
`Review/VerdictActions.svelte` (first seen at greater-v0.12.0; still present at
the current **greater-v0.13.1** pin, where every control is `size="sm"` — the
component's bytes are unchanged from 0.13.0).

Every control the component renders is `size="sm"` — both verdict buttons, both
dialog buttons, and the dialog's close control — and the vendored primitives
theme sizes that variant `min-height: 2rem` (32px). On a phone, the two
decisions a reviewer makes are the smallest targets on the screen. Product
design §4 sets a 44px floor, and contentus's own controls beside them
(`.contentus-review-publish__*`, `.contentus-review-segmented__option`) meet it.

**Ask:** raise the review chrome's controls to a 44px minimum, or expose `size`
as a prop on `VerdictActions` so a consumer can. The buttons are a decision
surface, not a toolbar.

**What contentus did while this is open:** a **sizing bridge** in
`src/lib/brand/bridge.css` — the pattern `src/lib/brand/compose.css` established
at M3 — raising the vendored selectors to 44px. Appearance only; the component
is not edited and stays CLI-managed. The block carries a swap-to-vendored header
and is deleted when this ask lands. Asserted in `tests/mobile-chrome.test.mjs`
against the selectors the component actually emits.

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

**Where:** `equaltoai/lesser`, GraphQL contract.

`draftReview(id)` is per draft. A queue that wants the review state of the
viewer's own drafts must fan out one query per draft, which is what contentus
now does (bounded concurrency, nothing dropped).

**Ask:** either review fields on `type Draft` for the owner — `reviewStatus`,
`verdicts` — or a `myDraftReviews(...)` connection returning `DraftReview` for
the caller's own drafts. `DraftReviewForCaller` already authorizes the owner for
each of them individually, so this exposes no new access.

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

### 3. Live instance round trip on `trenchcoat` — NOT RUN

Non-gating by operator ruling (2026-07-31), and reported rather than skipped
quietly. What was attempted and what it returned:

| Attempt                                      | Result                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `https://trenchcoat.lesser.host/api/graphql` | DNS does not resolve                                                  |
| `https://lab.lesser.host/api/graphql`        | HTTP 404 — not the instance's GraphQL surface                         |
| lesser-body MCP `article_draft_*` tools      | no such endpoint is connected to this session                         |
| `lesser client install` to the dev instance  | operator-only; the steward does not run installs on its own authority |

The runbook's config-free deploy section derives a stage origin from the
operator-supplied `--stage` and `--base-domain` values for verification only;
it deliberately keeps no instance registry. No operator-run install outcome
has been recorded, so there is no verified address to reach. M2b also landed
on lesser-body's `staging` rather than `main`, so the parity surface is not
deployed anywhere this session could reach even with an address.

**None of this is evidence that the round trip fails.** It is the absence of
evidence, and it is recorded as such. The live round trip is an operator-run
step: install contentus to the dev instance, then drive one draft through
contentus and through the Body tools. Its outcome belongs on issue #14 when it
happens.

## What contentus refused to do

- Render Markdown client-side, anywhere, for any preview.
- Display `Draft.content` — the preview is `draftPreview.renderedHtml` or an
  explained failure with lesser's own deterministic errors.
- Offer verdict actions from the queue, which would let an approval be given
  without reading the rendered draft.
- Compute the approval gate, gate the publish button on that computation, or
  predict the `reviewStatus` a verdict will produce.
- Auto-publish anything, under any condition.
