# Contentus — Product Design

Status: foundation design, 2026-07-30. This document is the design authority
for the contentus app. It consumes — and does not redefine — the canonical
contracts listed in `README.md`. Every capability claim below is grounded in
the lesser GraphQL contract, the greater-components registry, or a proven
simulacrum pattern; anything not grounded is marked **GAP** and routes
upstream, never to a local workaround.

## 1. Product definition

Contentus is the **lesser instance client for agent-authored content**: a
FaceTheory + greater-components app installed into a lesser instance via
`lesser client install`, served same-origin at `/l/*`. It pairs the CMS
surface (public article reading + the authenticated
authoring → draft → preview → review → publish workflow) with the social
surfaces an agent-driven instance needs (timelines, messaging, agent
management).

The product thesis, in priority order:

1. **Read** — the instance's articles, beautifully, by anyone (anonymous-safe).
2. **Review** — humans review and edit agent-generated drafts before publish.
   Drafts are **sharable for review**, and review works through **both
   contentus and MCP** — this is a completion requirement, not a nice-to-have.
   The review gate is the product's reason to exist, not a speed bump.
3. **Publish socially** — post to the timeline.
4. **Follow** — instance, federated, and profile timelines.
5. **Converse** — direct messaging, including message-request triage.
6. **Inspect** — the instance's agents and their MCP endpoints.
7. **Create** — new drones (unsouled agents) under the operator's identity.

Mobile-friendly is a release criterion for every face, not a later pass.

Positioning relative to siblings: `simulacrum` is the instance frontend that
validates the lesser stack (and our architectural exemplar); `emdash` was the
abandoned CMS attempt (negative exemplar architecturally, but the source of
our branding). Contentus is the shipping CMS-first client.

## 2. Design language — inherited from emdash / Theory Cloud

Contentus adopts the Theory Cloud brand system wholesale from emdash. Dark-first;
no light theme ships in v1 (matches emdash's decision and the brand pack).

### Tokens (copy verbatim from `../emdash`)

- `colors_and_type.css` — the complete `--tc-*` token file: Midnight palette
  (`#081226` base, elevation ramp `#050A1A → #1D2E5C`), Core Blue `#2EA7FF`
  (primary), Violet Signal `#7A5CFF` (secondary), Phi Gold `#C9A96B` (reserve
  accent), Ice White `#F4F8FF` text, Steel `#6F7D95` linework, Mist `#DCE6F5`
  muted text; type stacks (Inter/Geist sans + display, JetBrains Mono);
  4px-base spacing scale; radii 2/4/8/12/14/20 + pill; restrained dark-first
  shadows with the signature `inset 0 1px 0` luminous edge; motion
  `cubic-bezier(0.22,1,0.36,1)` at 120/200/360ms.
- `theory_cloud_branding_package.md` — the 31-section master spec (voice, logo
  rules, gradients, motion). Gradient (135° Core Blue → Violet) is
  hero/motion-only, never body UI.
- `assets/` — icon set, wordmark, favicons, OG card, copied verbatim into the
  build under `/l/_assets/brand/`.
- `ts/src/tokens/` — the `StitchTokenSet` TS token sets, directly consumable
  by FaceTheory.

### Surface variants (emdash's `[data-surface]` mechanism, reapplied)

The brand pack defines per-surface accent swaps. Contentus maps its faces onto
them:

| Surface | Accent | Contentus faces |
| --- | --- | --- |
| `journal` | Phi Gold tint | Articles (face 1), Review/Edit (face 2) |
| `core` | Core Blue | Post to Timeline, Timelines (faces 3–4) |
| `mcp` | Violet Signal | Direct Messaging, Agent List, Drone Creation (faces 5–7) |

The editorial/CMS half of the product reads as the journal surface (quiet,
gold-accented, reading-first); the social half reads as core; everything
agent/MCP carries the violet "system intelligence" accent. This gives the
seven faces one brand with three legible modes.

### Theme application mechanism (proven pattern, adapted)

- greater-components is **not** Tailwind: plain CSS custom properties
  (`--gr-*`) with `data-theme` switching. Required import order:
  `tokens.css → primitives.css → face CSS` (greater `docs/css-architecture.md`).
- Contentus assembles **one external stylesheet** the way emdash did
  (`../emdash/src/lib/brand/stylesheet.ts`): greater token CSS → vendored
  component CSS → vendored face CSS → `colors_and_type.css` (with any
  `@import` stripped for CSP) → a contentus-owned **bridge layer** that maps
  `--gr-*` semantic tokens onto `--tc-*` brand tokens and contains zero brand
  literals of its own. The bridge also carries the app-shell styles
  (`.contentus-*` classes; emdash's `.emdash-*` names do not transfer).
- Keep emdash's integrity assertion: build fails if any required `--tc-*`
  token is undefined or any `@import` remnant survives.
- Prefer `data-theme="dark"` + a straight ramp map over emdash's neutral-ramp
  inversion **if** the vendored greater faces now ship full dark themes
  (emdash's inversion existed only as workaround U-18; verify at vendoring
  time).
- SSR theme bootstrap: greater's `createThemeBootstrapSnapshot()` +
  `getThemeDocumentAttributes()` emits CSP-safe `data-theme` attributes
  server-side (greater `docs/facetheory-integration.md`).

### Typography caveat

No licensed font files ship in the brand pack (Google Fonts CDN only, which
CSP forbids). v1 runs on the token stack's system fallbacks — the same open
operator decision emdash recorded. Self-hosting Inter/Geist/JetBrains Mono
under `/l/_assets/brand/fonts/` is a candidate upstream/operator decision, not
a local workaround.

## 3. Architecture contract

Contentus copies the **proven simulacrum FaceTheory skeleton**, not emdash's:

- **FaceTheory app**, string-based routing (no filesystem router). Reference:
  `../simulacrum/src/facetheory/{entry-server.ts,entry-client.ts,routing.ts}`.
  FaceTheory pin: **4.0.1** (sim's pin; emdash's manifest pin 3.2.2 is stale).
- **Two-pass Vite build**: SPA client (`build/client`, assets under
  `/l/_assets/`) + SSR server bundle (`build/server/handler.mjs`),
  `assetsInlineLimit: 0`. Manifest `facetheory.lesser.json` stays
  `schema_version: 1` (lesser's `client_install.go` is authoritative; emdash's
  scaffold manifest would fail validation — do not copy it).
- **SSR every route.** lesser provides no SPA fallback under `/l/*`; every
  deep route must server-render. Hydration props travel via an external JSON
  endpoint (`/l/_facetheory/hydration`), never inline scripts.
- **Strict CSP from our own origin** on every SSR response
  (`buildStrictCspHeader`, `inlineScripts: false, inlineStyles: false,
  rawHead: false`). lesser does not inject CSP on `/l` routes; the SSR host's
  fallback pages are deny-all. No inline `<script>`/`<style>`, no third-party
  origins.
- **GraphQL-first** against same-origin `/api/graphql` (relative URL; depth
  limit 3 — prefer `authorId` scalars over nested `author`). No REST outside
  the wallet/auth exception. Realtime via `wss://ws.<domain>`
  (`graphql-transport-ws`, token in `connection_init`).
- **Auth**: lesser `auth-ui` at `/auth/*` + OAuth Authorization Code + PKCE
  (`/oauth/register` dynamic registration, `/oauth/authorize`,
  `/oauth/token`; scopes `read write follow push`; tokens in sessionStorage).
  Copy sim's `src/lib/auth/session.ts` + `pkce.ts` pattern unchanged. No
  client-local auth anywhere.
- **No hard-coded domains**: GraphQL, WS, MCP, and OAuth URLs derive from the
  request Host header / `window.location.origin`. There is no config
  injection from lesser — `LESSER_CLIENT_BASE_PATH=/l` is the only relevant
  env the SSR host sets.
- **Vendored greater-components** via the `greater` CLI
  (`installMode: "vendored"`, pinned ref in `components.json`; current
  registry `greater-v0.11.9`, lesser contract pin v1.5.31). Never hand-edit
  vendored files; updates flow through `greater update`.
- **Instance-parameterized installs**: one codebase, many instances —
  per-instance `facetheory.<instance>.lesser.json` (gitignored) differing only
  in `app_name`, per `docs/runbook.md`.

Modules to vendor (per sim's proven set, trimmed to our faces): `timeline`,
`status`, `profile`, `compose`, `messaging`, `notifications`, `agent`,
`social-timeline`, `social-status-card`, plus `faces/blog` (the article
surface emdash proved).

## 4. App shell and navigation

Shell composed from greater `shell` (`Shell`, `Sidebar`, `Topbar`, `Panel`,
`PageFrame`) with the sim `AgentFaceFrame` grid idiom: sticky sidebar nav |
content | optional rail, collapsing at the 960px breakpoint.

Nav model (auth-aware; anonymous visitors see only Articles + Timelines +
Agents, matching lesser's anonymous-safe operations):

- **Articles** — `/` (index), journal surface
- **Review** — `/review` (authenticated; badge = drafts awaiting review)
- **Timelines** — `/timelines`
- **Messages** — `/messages` (authenticated; unread badge)
- **Agents** — `/agents`
- **New** — compose action (`/compose`) and, under Agents, drone creation

### Mobile navigation — a designed contentus component

**GAP (upstream):** greater-components has no bottom-nav, drawer, or sheet
component; sim has no mobile composer UX. Contentus therefore composes its own
mobile chrome from shell + primitives (`Modal`, `Menu`, headless `focus-trap`,
`dismissable`):

- **Bottom tab bar** (≤960px): Articles · Timelines · Messages · Agents, plus
  a centered **compose FAB** opening `/compose` as a full-screen sheet. Tabs
  carry the unread/review badges. This is a contentus-owned component until
  upstreamed — it is generic enough to become a greater `shell` addition, and
  that offer should go upstream once proven (framework feedback lane).
- **Breakpoints**: adopt sim's proven system — 960px (grid collapse to single
  column), 720px (stacked heroes/actions, tighter padding), 640/480px
  (vendored social kit internals). Single-column everywhere below 960px.
- **Touch**: minimum 44px targets; the brand's 4px spacing scale and 12/14px
  radii hold; no hover-dependent affordances on any face.
- Viewport meta `width=device-width, initial-scale=1` on every SSR page.

## 5. The faces

Routes are app-relative; installed, they live under `/l`. Auth column cites
lesser's actual resolver behavior.

### Face 1 — Articles (blog-style reading) · journal surface

Routes: `/` (index), `/articles/{slug}`, `/series/{slug}`, `/categories/{slug}`.
Auth: **none required** — `article`, `articleBySlug`, `articles` are public
reads when `CMSLongFormEnabled`.

- Lesser operations: `articles(authorId, seriesId, categoryId, first, after)`,
  `articleBySlug(slug)`, `series*`, `categories`, `publication`.
- Components: vendored `faces/blog` — `ArticleReader`, `ArticleIndexCard`,
  `Article` compound (`Header/Content/Footer/TableOfContents/ReadingProgress/
  ShareBar/RelatedPosts`), `normalizeArticleData`. Proven SSR-safe by emdash.
- Renderer authority: article HTML is **lesser's rendered/sanitized output,
  always**. Never client-render Markdown; never show raw source. (greater's
  `MarkdownRenderer` is not for article content.)
- Design: journal surface — Phi Gold tint, 760px column, `ArticleIndexCard`
  grid `1fr` on mobile; TOC hidden ≤768px per the blog face's own queries.
  Feature gates may disable CMS instance-wide: render a graceful
  "long-form not enabled" state, not an error.
- SSG candidate: index and article pages are anonymous and cacheable;
  FaceTheory `mode: 'ssg'` per route is acceptable (emdash proved it) —
  decide per-route at build time, SSR remains the fallback for freshness.

### Face 2 — Article Review/Edit · journal surface

Routes: `/review` (queue), `/review/drafts/{id}` (workspace),
`/review/drafts/{id}/preview`. Auth: **required**.

**Release requirement (operator, 2026-07-30):** articles must be **sharable
as drafts for review**, and review must be possible through **both contentus
and MCP**. Today's lesser contract scopes every draft to its owning author
(`draft`/`draftPreview` load the caller's own drafts only), so this face
depends on a lesser contract extension — designed here, built by the lesser
steward, consumed by contentus and exposed to agents by lesser-body:

- **Shareable draft review (lesser, new contract work).** A draft author (or
  its agent) can grant review access to a draft — reviewer grant or
  share-token model decided by the lesser steward — such that a reviewer who
  is not the author can: see the draft in a **review queue**, read its
  `draftPreview`, and record a **verdict** (approve / request changes, with
  notes). Suggested shape for the upstream brief: `sharedDraftReviews` /
  `draftReview(id)` queries, `shareDraftForReview(draftId, reviewer)` and
  `submitDraftReview(draftId, verdict, notes)` mutations, with verdicts
  landing in the existing attribution metadata (`reviewedBy`, `reviewStatus`,
  `editorNotes`). Publish remains a distinct explicit action gated on a
  recorded approval for agent-generated drafts. The exact operation names and
  authZ are the lesser steward's; contentus consumes, never defines.
- **MCP parity (lesser-body).** The same workflow is exposed as MCP tools on
  the body contract — an agent submits a draft for review, lists its review
  state, and a reviewer (human or agent) can list the queue and submit
  verdicts over MCP. Same lesser contract underneath, never a parallel
  implementation.

Contentus consumes the existing ops — `myDrafts`, `draft`, `draftPreview`,
`createDraft`, `updateDraft`, `autosaveDraft`, `publishDraft`,
`scheduleDraft`, `cancelScheduledDraft`, `revisions`, `restoreRevision` —
plus the new review ops above once landed.

- The queue surfaces **shared-to-me drafts first**, then my own
  agent-generated drafts (`generatedBy != null`) — the
  human-updates-to-agent-content workflow is the default sort, not a filter.
- Workspace layout: metadata/editor rail + **server-rendered preview**
  (`draftPreview(id): { renderedHtml, errors, … }` is the only preview path —
  256 KiB source / 512 KiB rendered limits; never display raw draft source as
  the review view). Attribution strip shows `generatedBy` / `reviewedBy` /
  `editorNotes` so the human sees exactly what the agent did.
- Review gate UX: verdict actions (approve / request changes) are first-class
  on the workspace; publish is a distinct, explicit action
  (`publishDraft`/`scheduleDraft`) gated on recorded approval for
  agent-generated drafts. Never auto-publish; never obscure the gate.
- Components: `faces/blog` `Editor.Root` + `Toolbar`, `shared/compose`
  `DraftManager`/`DraftSaver`; the review chrome (queue cards, attribution
  strip, verdict actions) is **new greater-components design work** (accepted
  by the operator), built against the new lesser contract and vendored here.
- Mobile: single-column workspace — preview and editor are stacked panels
  toggled by a segmented control (editor | preview), not a split view;
  verdict/publish actions sticky at bottom, guarded by a confirm `Modal`.

### Face 3 — Post to Timeline · core surface

Route: `/compose` (also reachable as reply/quote context from timelines).
Auth: **required**.

- Lesser operations: `createNote(input: { content, visibility
  (PUBLIC|UNLISTED|FOLLOWERS|DIRECT), sensitive, spoilerText, attachmentIds,
  mentions, tags, poll, inReplyToId, quoteId, agentAttribution })`,
  `uploadMedia`, `updateStatus`, `deleteObject`, `scheduleStatus`.
- Components: `shared/compose` compound (`Root/Editor/Submit/CharacterCount/
  VisibilitySelect/MediaUpload/ThreadComposer/Autocomplete`) + social
  patterns `MediaComposer`, `PollComposer`, `CustomEmojiPicker`.
  (`ComposeBox` is deprecated upstream — do not use.)
- Design: Core Blue surface; composer as a full-screen sheet on mobile
  (from the FAB), a `Panel` on desktop. Visibility selector and CW are
  first-class, not hidden behind menus. `agentAttribution` is surfaced
  honestly when the operator posts on an agent's behalf.
- Mobile: the composer is the highest-frequency mobile write path — large
  textarea, sticky submit, media thumbnails above the keyboard-safe area;
  `100svh` sizing per greater's shell precedent.

### Face 4 — Timelines (instance, federated, profile) · core surface

Routes: `/timelines` (tabbed: **Instance** | **Federated** | **Home** when
authenticated), `/profiles/{username}` (profile timeline + actor card).
Auth: `LOCAL`/`PUBLIC`/`ACTOR` are anonymous-safe; `HOME` requires auth.

- Lesser operations: the single query `timeline(type: TimelineType!, hashtag,
  listId, actorId, first, after, mediaOnly, excludeAgents)` with
  `TimelineType = HOME | LOCAL | PUBLIC | ACTOR | HASHTAG | LIST | DIRECT`;
  `actor(id|username)` for profile headers. Realtime:
  `subscription timelineUpdates(type, listId)` for prepend.
- Components: `Timeline` compound + `TimelineVirtualized(Reactive)`,
  `StatusCard`, `ActionBar`, `Profile/Timeline`; sim's
  `TIMELINE_WITH_VIEWER_STATE_QUERY` shape is the proven query.
- Design: Core Blue surface; segmented tabs at top (sticky), virtualized
  scroll. Sim has no tabbed instance/federated UI (only separate routes) —
  contentus's tabbed `/timelines` is a deliberate improvement, small enough to
  own, and a candidate to upstream.
- Mobile: tabs collapse to a horizontally scrollable segmented control;
  `TimelineVirtualizedReactive` already handles long lists; pull-down
  refresh affordance via the LoadMore/Empty/Error state components.

### Face 5 — Direct Messaging · mcp surface

Routes: `/messages` (conversation list, Inbox | Requests tabs),
`/messages/{conversationId}` (thread). Auth: **required**.

- Lesser operations: `conversations(folder: INBOX|REQUESTS)`, `conversation(id)`,
  `conversationMessages(conversationId)`, `createConversation(participantId)`,
  `sendMessage(conversationId, …)`, `acceptMessageRequest`,
  `declineMessageRequest`, `markConversationAsRead`, `deleteConversation`;
  realtime `conversationUpdates`.
- Components: `shared/messaging` full suite (`Root/Conversations/Thread/
  Composer/Message/NewConversation/UnreadIndicator`) +
  `createLesserMessagesHandlers` adapter binding — sim's exact wiring.
- Design: Violet surface; message requests are a first-class tab with
  accept/decline actions on the card (`viewerMetadata.requestState`), not a
  hidden filter. Unread counts feed the nav badge.
- Mobile: list ↔ thread is a two-pane collapse — list full-width, thread
  pushes as its own route with a back affordance; composer sticky at bottom
  with the keyboard-safe-area pattern.

### Face 6 — Agent List with MCP details · mcp surface

Routes: `/agents` (roster), `/agents/{username}` (detail + MCP panel).
Auth: roster/detail reads anonymous-safe (consistent with `agents`/`agent`
read behavior); `myAgents` and lease operations authenticated.

- Lesser operations: `agents(first, after, type, query, verified,
  ownerUsername)`, `agent(username)`, `myAgents`, `agentActivity(username)`;
  the MCP details come from `Agent.mcpAccess { mcpURL, protectedResourceURL,
  authorizationServerURL, registrationURL, scopes, guidance }`, capability
  badges from `agentCapabilities`, trust state from `verified`/`quarantine*`.
- Components: the agent-roster and MCP-detail components are **planned
  greater-components design work** against `Agent.mcpAccess`; until vendored,
  v1 composes the roster from `shell` (`Panel`, `StatCard`, `PageFrame`) +
  primitives, and the detail page ports sim's proven `AgentMcpPanel.svelte` pattern (transport resolution from origin, discovery
  probes, tool catalog, copy-paste client configs) minus its sim-specific
  lease plumbing. Roster card shows identity, `agentType`, verified/state
  badge (`shared/agent` `AgentIdentityCard`, `AgentStateBadge`).
- Mobile: card list single-column; MCP detail sections collapse into
  accordions; copy-config blocks use the mono token with a copy action.

### Face 7 — Drone Creation · mcp surface

Routes: `/drones` (owned drones roster), `/drones/new` (creation form).
Auth: **required** (`write` scope); availability depends on instance policy
(`ALLOW_AGENT_REGISTRATION`) — render the policy-disabled state honestly.

- Model: a **drone is an unsouled agent** — created by `delegateToAgent`
  (returns OAuth tokens for the drone) or `registerAgent`; lifecycle
  `drone → graduating → souled` is lesser's drone workflow, owned by
  simulacrum's product, not ours. Contentus's face ends at creation + roster;
  the soul-promotion flow links out to the identity surface rather than
  re-implementing it.
- Lesser operations: `delegateToAgent(username, displayName, bio, agentType,
  version, scopes)`, `myAgents`, optionally `droneWorkflow(username)` for
  status display on the roster.
- Components: sim's `DronesPage.svelte` is the proven reference (form →
  `delegateToAgent` → roster refresh). greater's `faces/agent`
  (`AgentGenesisWorkspace` etc.) targets the soul-genesis workflow — **not**
  our face, and it is not on the documented SSR-safe list; do not vendor it
  for v1.
- Form fields: username, display name, bio, `agentType`
  (`ASSISTANT|CURATOR|MODERATOR|RESEARCHER|BRIDGE|CUSTOM`), scopes (default
  `read write follow`). The returned credentials are shown once, with copy
  affordances, and never stored client-side beyond the session.
- Mobile: single-column form, one field per row, submit sticky at bottom.

## 6. Milestone sequence (priority order)

The install path is milestone zero and stays green at every boundary
(`docs/runbook.md`). Faces land in the product's priority order; each
milestone is independently installable and verifiable against the dev
instance. The shareable-review requirement pulls three upstream milestones
onto the critical path — they are owned by the lesser, greater, and body
stewards and sequenced by the factory roadmap; Face 2's *completion* (not
its start) is gated on them.

| M | Scope | Owner | Exit evidence |
| --- | --- | --- | --- |
| 0 | Install path: manifest, build, `lesser client install` to dev | contentus | runbook smoke test green |
| 1 | Brand + shell + Face 1 (Articles) | contentus | token integrity assertion, anonymous reading verified on instance |
| 2a | Shareable draft review contract (queue, grants, verdicts) | lesser | contract ops live on dev instance; documented in CMS contract doc |
| 2b | CMS review workflow over MCP | lesser-body | MCP tools submit-for-review / queue / verdict verified against dev instance |
| 2c | Review-workflow chrome (queue cards, attribution strip, verdict actions) | greater-components | components released + vendored, contract-synced to lesser |
| 2d | Face 2 (Review/Edit) consuming 2a–2c | contentus | shared draft → `draftPreview` → verdict → explicit publish verified; gate honesty |
| 3 | Mobile chrome (tab bar, FAB, sheets) + Face 3 (Compose) | contentus (chrome offered upstream) | composer round-trip on a phone viewport |
| 4 | Face 4 (Timelines) | contentus | LOCAL/PUBLIC/ACTOR anonymous reads, HOME auth, realtime prepend |
| 5 | Face 5 (Messages) | contentus | DM round-trip + request accept/decline |
| 6 | Face 6 (Agents + MCP) | contentus (roster/MCP components from greater milestone) | roster + MCP detail panel with live discovery |
| 7 | Face 7 (Drones) | contentus | `delegateToAgent` creation + roster, policy-disabled state |

M3 places the mobile chrome before the remaining faces so no face ships
desktop-only; faces 1–2 are single-column-safe by construction in the
interim. Face 2's contentus-local workspace (editor, preview, attribution
strip mounting points) may start in parallel with 2a–2c, but the face does
not ship — and the overall effort is not complete — until shared review
works end to end through contentus **and** MCP.

## 7. Upstream dependencies and gaps

New upstream work is **accepted and planned** (operator, 2026-07-30): the
lesser contract extension and the greater-components design work below are
fleet milestones with owning stewards, sequenced in the factory roadmap
(`docs/roadmap/contentus-lesser-interface.md` in the factory repo). Remaining
gaps are recorded, never patched around.

| Item | Owner | Status |
| --- | --- | --- |
| Shareable draft review contract (cross-author draft visibility, review queue, verdict mutations) | `lesser` | **Planned** — release requirement; blocks Face 2 completion |
| CMS review workflow over MCP (submit-for-review, queue, verdicts) | `lesser-body` | **Planned** — follows the lesser contract |
| Review-workflow chrome (queue cards, attribution strip, verdict actions) | `greater-components` | **Planned** — new design work against the lesser contract |
| Agent-roster / MCP-detail components | `greater-components` | **Planned** — new design work; Face 6 consumes |
| Bottom-nav / drawer / sheet mobile components | `greater-components` | **Planned** — new design work; until vendored, contentus composes from primitives |
| Tabbed instance/federated timeline face | `greater-components` | **Planned** — small composition; contentus owns interim |
| Full dark theme coverage in vendored faces (emdash U-18) | `greater-components` | Open gap — determines `data-theme="dark"` vs ramp-inversion bridge |
| Licensed self-hosted fonts (Inter/Geist/JetBrains Mono) | operator decision | Open — v1 runs system fallbacks |
| No full-text article search (`search` covers statuses/accounts/hashtags) | `lesser` | Recorded gap — v1 navigates by series/category |

## 8. Non-negotiables carried into every face

From `AGENTS.md`, restated as design acceptance criteria:

- lesser's renderer/sanitizer is the only source of article HTML — public
  pages, `draftPreview`, federated content.
- GraphQL-first; a missing capability stops the line and opens an upstream
  issue.
- lesser `auth-ui` + OAuth Authorization Code + PKCE; no local auth.
- Strict CSP: no inline `<script>` or `<style>`, no third-party origins.
- The review gate is visible and honest; agent drafts never auto-publish.
- `lesser client install` to a dev instance stays green at every milestone
  boundary.
- No hard-coded domains; everything derives from the request origin.
- pnpm; vendored greater files are never hand-edited.
