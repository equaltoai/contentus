# Shared-draft review — what contentus consumes, and the gaps it routed

Status: recorded at M2d (2026-07-31), verified against lesser release
**v1.5.32** and the greater-components **greater-v0.12.0** release.

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

### 2. You cannot review your own draft

`DraftService.SubmitDraftReview` refuses when `caller == owner`, unless the
caller is the instance principal:

```go
if caller == owner {
    principal, err := s.instancePrincipal(ctx)
    if err != nil || principal != owner {
        return nil, errors.New("draft owner cannot review their own draft")
    }
}
```

It then requires `ActiveDraftReviewGrant(ctx, owner, draftID, caller)`.

Contentus therefore offers the verdict actions when `DraftReview.grant` is
present — the projection's `grant` is the **viewer's own** invitation, set from
the `g` that `DraftReviewForCaller` returned — and explains the requirement when
it is not. That is reading a field lesser publishes, not reconstructing the
policy.

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

## What contentus refused to do

- Render Markdown client-side, anywhere, for any preview.
- Display `Draft.content` — the preview is `draftPreview.renderedHtml` or an
  explained failure with lesser's own deterministic errors.
- Offer verdict actions from the queue, which would let an approval be given
  without reading the rendered draft.
- Compute the approval gate, gate the publish button on that computation, or
  predict the `reviewStatus` a verdict will produce.
- Auto-publish anything, under any condition.
