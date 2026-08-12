# Planning: Agent share-grants + act-as (M7.0)

Status: planned. Phase 1 (contract sync) is the first PR; phases 2–5 follow.

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
3. Act-as on the CMS surface contentus actually has — the review workflow
   (`sharedDraftReviews`, `myDraftReviews`, `draftReview`, `draftPreview`,
   draft ownership, `submitDraftReview`, `shareDraftForReview`,
   `publishDraft`) via the header on the GraphQL-HTTP endpoint.
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
   from `shared-with-me`, cleared on sign-out, cleared on a 403.
5. `actedBy` in review attribution (query → mapping → attribution strip).
6. Owner "Sharing" panel on the MyAgents surface.
7. "Shared with me" panel + act-as selector on the agents route.
8. Thread act-as through the review transport; on a 403, clear the selection
   and notify — revocation mid-session is the designed case.
9. Act-as banner on the review queue and workspace.
10. Runbook share-flow verification steps + consumption note.

## Roadmap

Five phases; rollout is principal-deployed and principal-verified.

- **Phase 1: contract baseline** — item 1. Gates item 5's document validation.
- **Phase 2: transport + share client** — items 2, 3 (parallel).
- **Phase 3: act-as context** — item 4 (depends on 3).
- **Phase 4: agents UI** — items 6, 7 (depend on 3, 4).
- **Phase 5: review-surface act-as + attribution** — items 5, 8, 9
  (depend on 1, 2, 4). Cross-client adversarial review concentrates here.

Install rollout: CI gates green on the PR (lint, svelte-check, tests, build,
CSP audit, rubric gate, DCO) → operator merges to `staging` → steward builds
and prepares the verification checklist → principal runs `lesser client
install` on the dev instance (trenchcoat) and verifies the share flow
(grant → discover → act-as verdict/publish → `actedBy` visible → revoke →
403 clears the selection) or requests changes → steward records the receipt.

Rollout prerequisite: the dev instance must run lesser ≥ v1.6.5. The panels
degrade honestly on older instances, but the share flow itself needs the real
endpoints.

Rollback: revert the merge on `staging`, rebuild, reinstall. The feature is
additive; grants live in lesser and are unaffected by a client rollback.

Open questions: drones-face act-as (deferred; the transport option will be
shared); a served capability flag (optional upstream ask, not filed).
