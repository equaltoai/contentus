# Planning: Agent share-grants + act-as (M7.0)

Status: in flight. Phase 1 (contract sync) merged as PR #88. Phases 2–4
(items 2, 3, 4, 6, 7) merged as **PR #89** (`81c538d` on `staging`). Phase 5
(items 5, 8, 9) is in flight on branch
`theorymcp/equaltoai/contentus/m7-review-act-as-attribution`, targeting
`staging`.

Provenance: the implementing client for this PR is the **contentus steward**
(Kimi Code session, `kimi_code` install profile) — recorded here so the
phase-5 review does not hit the same wall PR #89's review did. The adversarial
review (Claude, `adversarial-pr-review`) posted COMMENT on PR #89 at head
`c21c9b2`: 4 findings (1 medium — the panels' session-scope discipline was
described but unprobed; 3 low — the per-agent 404 read as an instance-wide
claim, the unguarded share-list response shape, and share panels mounted on
list membership instead of lesser's served ownership statement) plus this
provenance gap. All were closed by follow-up commits; the re-review at
`390a3bb` verified the closures by mutation and probe, raised 2 more lows
(`grantsFrom` contents, the unprobed ownership gate), and those are closed
too. Both passes and their closures are recorded in PR #89's body.

This document consolidates the four planning artifacts for the milestone:
scoped need, CMS-consumption audit, enumerated changes, roadmap. It records
decisions; it is not a contract. lesser's `docs/contracts/agent-share-grants.md`
and `docs/contracts/agent-share-act-as.md` (v1.6.5) are the authority for the
capability itself.

## Scoped need

lesser v1.6.5 shipped agent share-grants: an agent owner (or admin) can grant
another **local** lesser account access to their agent, and the grantee then
acts agent-scoped by sending `X-Lesser-Act-As: <agentUsername>` on enabled
surfaces, with the real caller recorded as `actedBy` attribution. Attribution
only, never impersonation; lesser re-checks the grant on every request and a
revoke takes effect on the very next one.

Contentus has no UI for any of it. The milestone closes the full loop on
contentus's actual surfaces:

1. Owner grant management — grant/revoke/list, REST-only by lesser design
   (`GET`/`PUT`/`DELETE /api/v1/agents/{username}/share[/{grantee}]`).
2. "Shared with me" discovery (`GET /api/v1/agents/shared-with-me`).
3. Act-as on the CMS surface contentus actually has — the review workflow —
   via the header on the GraphQL-HTTP endpoint. lesser's enabled operations
   are the reads `draft`, `draftPreview`, `myDrafts`, `sharedDraftReviews`,
   `draftReview` and the writes `submitDraftReview`, `shareDraftForReview`,
   `publishDraft`. On any unlisted operation the header is silently ignored
   and the request runs with owner semantics — so `myDraftReviews` (which
   contentus's queue uses for its own-drafts half) is NOT agent-scoped under
   act-as, and the design must treat that as a stated limitation, never as
   agent behavior.
4. `actedBy` attribution display on the review surface.

Driver: principal-direct. Classification: cms-client milestone with an
upstream-sync prerequisite (this contract sync).

Key scoping facts:

- greater-components v0.13.5 — already pinned on both channels — ships typed
  adapters for the whole capability; the vendored generated REST types already
  contain the endpoints and header params.
- Contentus has **no** `createDraft`/`updateDraft` UI: its CMS surface is
  review-centric, so "act-as authoring" here means act-as reviewing and
  publishing. Draft creation stays an agent/MCP lane.
- `scheduleDraft` is deliberately **not** in lesser's act-as enabled list (a
  scheduler-driven publish cannot carry honest caller attribution). No act-as
  threading reaches it.
- `Article.actedBy` display is excluded: it is author/admin-viewers-only
  workflow attribution and contentus's article surfaces are public reading.

## CMS-consumption audit (six dimensions, all conforming)

- **GraphQL-first: conforming, with a documented exception.** Every CMS data
  operation stays GraphQL. The REST paths are lesser's _agent management
  plane_ (shares sit beside delegation, access leases, agent update/delete —
  all REST-only by lesser design), not CMS data. In-repo precedent:
  `LesserSoulClient` (souls REST), timelines/notifications via greater social
  adapters. Ruling: consume via a thin typed client, same pattern.
- **Auth: conforming.** auth-ui + PKCE untouched. Share management needs
  `write` (or `write:accounts`), `shared-with-me` needs `read`; the default
  `read write follow push` scope covers both. No scope or flow change.
- **Review gate: preserved, with one honesty requirement.** lesser enforces
  publish eligibility server-side regardless of act-as; contentus never
  re-derives it. The act-as banner must be present on review and publish
  surfaces, and `actedBy` sits beside `generatedBy`/`reviewedBy`/`publishedBy`
  — acting as the agent is always legible, never silent.
- **Identity: conforming.** Article IDs/slugs used exactly as returned.
- **Mode gating: behavioral detection required.** No contract-served
  capability gate exists for shares (`CMSFeatures` has no agents/shares flag
  even at lesser HEAD). Share panels ride the existing agents-surface gate
  (`ensureAgentsEnabled`), and a pre-v1.6.5 instance produces an honest
  "not supported by this instance" state from the endpoint's failure — never
  a visible-but-dead control. `actedBy` display is presence-driven. Optional
  future upstream ask: a served capability flag.
- **CSP: compliant.** Plain Svelte, same-origin fetches only.

## Enumerated changes (10 items, single-commit each)

1. Sync the lesser contract snapshot to v1.6.5 (provenance ritual; **this PR**).
2. `actAs` option on the GraphQL transport (`src/lib/cms/graphql.ts`).
3. Share-grant REST client (`src/lib/agents/share-client.ts`, contentus-owned —
   `src/lib/greater/adapters/lesser/client.ts` is vendored and never hand-edited).
4. Session-scoped act-as context (`src/lib/agents/act-as.ts`): selection derived
   from `shared-with-me`, cleared on sign-out, cleared when lesser says the
   grant is gone — error extension `FORBIDDEN` on GraphQL-HTTP, 403 on REST.
5. `actedBy` in review attribution (query → mapping → attribution strip).
6. Owner "Sharing" panel on the MyAgents surface.
7. "Shared with me" panel + act-as selector on the agents route.
8. Thread act-as through the review transport; when a CMS call returns error
   extension `FORBIDDEN` (GraphQL-HTTP reports it on HTTP 200, not as a 403 —
   that is the REST spelling), clear the selection and notify — revocation
   mid-session is the designed case.
9. Act-as banner on the review queue and workspace.
10. Runbook share-flow verification steps + consumption note.

## Roadmap

Five phases became four PRs; rollout is principal-deployed and
principal-verified.

- **Phase 1: contract baseline** — item 1. Gates item 5's document validation.
  **Merged (PR #88).**
- **Phases 2–4, combined into one PR** — items 2, 3, 4, 6, 7 as single commits
  in dependency order (2 → 3 → 4 → 6, 7). See "Re-sequencing" below.
  **Open as PR #89**, awaiting operator merge.
- **Phase 5: review-surface act-as + attribution** — items 5, 8, 9
  (depend on 1, 2, 4). Cross-client adversarial review concentrates here.
  In flight on `theorymcp/equaltoai/contentus/m7-review-act-as-attribution`.

### Re-sequencing (why phases 2–4 are one PR)

The seam-graph gate (`scripts/audit-seam-graph.mjs`, CI-core) fail-closes on
any git-tracked file inside the face (`src/lib/agents`) that no build pass
loads — "a face file the build never loads is a finding, not a silence". Items
3 (`share-client.ts`) and 4 (`act-as.ts`) are library modules whose consumers
are items 6 and 7; landing them a phase earlier leaves the gate red (23
seam-graph tests fail on the single finding). Weakening the gate or declaring
an exception is forbidden, and the gate binds at HEAD before push, not
per-commit — so the items land as separate commits on ONE branch, each
arriving before its consumers, with the tree green at HEAD. Discovered
2026-08-12 on branch `theorymcp/equaltoai/contentus/m7-transport-share-client`.

### Handoff state (2026-08-12/13, phase 5)

Branch `theorymcp/equaltoai/contentus/m7-review-act-as-attribution`, forked
from staging at the PR #89 merge (`81c538d`), carries phase 5, in order:

- `45d5b77` — docs: phase-5 status, provenance, and the contract fact that
  shapes item 5 (`DraftReview` has no `actedBy`; upstream ask G).
- `be0faa9` — item 5: `Draft.actedBy` displayed on the review workspace via a
  contentus-owned `draft(id)` read and a contentus-owned row beside the
  vendored `AttributionStrip` (which cannot be edited and whose input type
  cannot carry the field). Presence-driven throughout.
- `045cf4b` — item 8: act-as threaded through the review transport on the
  enabled operations; `myDraftReviews` and `scheduleDraft` opt out by design;
  a FORBIDDEN extension on an act-as request clears the selection, announces,
  and returns the named `act-as-revoked` failure. Adapter tests drive the real
  transport with the loader the act-as module needs.
- `a0bb04f` — item 9: `ActAsBanner.svelte` on the review queue and workspace,
  live-subscribed, absent with no selection, pinned by a structural probe.
- (this commit) — doc handoff update.

Remaining after this PR: item 10 (runbook share-flow verification steps) and
the install verification on the dev instance — `install-contentus-instance`
owns the build → operator-run `lesser client install` on trenchcoat →
verify grant → discover → act-as verdict/publish → `actedBy` visible →
revoke → next act-as call fails `FORBIDDEN` and the selection clears →
steward records the receipt. Cross-client adversarial review concentrates on
this PR.

Contract facts that bind items 4–7 (lesser v1.6.5, `agent-share-act-as.md`):

- Header `X-Lesser-Act-As: <agentUsername>` on GraphQL-HTTP; honored ONLY on
  lesser's enabled operations (reads `draft`, `draftPreview`, `myDrafts`,
  `sharedDraftReviews`, `draftReview`; writes `submitDraftReview`,
  `shareDraftForReview`, `publishDraft`). Elsewhere it is silently ignored
  and the request runs with OWNER semantics — `myDraftReviews` (the queue's
  own-drafts half) is NOT agent-scoped; design treats that as a stated
  limitation, never agent behavior.
- `scheduleDraft` is deliberately not act-as-enabled; no threading reaches it.
- Attribution only, never impersonation; lesser re-checks the grant per
  request; revoke takes effect on the next one — mid-session revocation is
  the designed case (item 8's clear-and-notify behavior, phase 5).

Install rollout: CI gates green on the PR (lint, svelte-check, tests, build,
CSP audit, rubric gate, DCO) → operator merges to `staging` → steward builds
and prepares the verification checklist → principal runs `lesser client
install` on the dev instance (trenchcoat) and verifies the share flow
(grant → discover → act-as verdict/publish → `actedBy` visible → revoke →
the next act-as call fails `FORBIDDEN` and the selection clears) or requests
changes → steward records the receipt.

Rollout prerequisite: the dev instance must run lesser ≥ v1.6.5. The panels
degrade honestly on older instances, but the share flow itself needs the real
endpoints.

Rollback: revert the merge on `staging`, rebuild, reinstall. The feature is
additive; grants live in lesser and are unaffected by a client rollback.

Open questions — resolved 2026-08-13 and routed to
`factory.equaltoai@theorymcp.ai` (delivery-8d8cae4ac3204cdc):

- **Drones: closed, no lesser change.** Drones are simply agents that have not
  yet gone through soul genesis; share-grants and act-as are mechanically
  identical, and the shared `actAs` transport option covers them.
- **Served capability flag: dropped, no lesser change.** Mode gating is not
  necessary given the pre-release state; the behavioral degradation on older
  instances is honest enough.
- **`myAgents` ownership: escalated.** Accessible agents must be clearly
  visible to a given user, with a subtle indication when the agent has a
  different owner, and a granted-access (non-owner) user must not be able to
  re-share such an agent. The pinned schema (`myAgents: [Agent!]!`) does not
  say whether membership means ownership, so if lesser needs an update to
  serve ownership, that is important to address. Panels remain mounted on
  lesser's served `viewerCanSeePrivateFields` (adversarial review of PR #89,
  finding 4).
- **`DraftReview` attribution: escalated** (upstream ask G in
  `docs/consumption/review-contract.md`). `DraftReview` is an important
  delegation path and must be supported in lesser: add a `DraftReview.actedBy`
  (or per-verdict `actedBy` on `DraftReviewVerdictRecord`) so delegated
  reviews carry the real caller.
