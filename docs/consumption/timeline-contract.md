# Face 4 — consuming lesser's timeline contract

What contentus learned reading lesser's timeline surface for M4, what it does
about each fact, and what it routed upstream instead of working around.

Verified against lesser at `graph/core.graphql`,
`graph/query_resolvers_notes.go`, `graph/subscription_resolvers_timelines.go`,
`graph/object_viewer_interactions_resolvers.go`,
`graph/query_resolvers_instance_parity.go` and `docs/api-reference.md`; against
greater-components at `greater-v0.12.0` (`c9825f8f`).

## Contract facts that changed the UI

### 1. Auth is per timeline type, and the query and the subscription disagree

`applyTimelineTypeFilter` demands a username for **HOME and DIRECT only**.
LOCAL, PUBLIC and ACTOR answer anonymously, which is what makes `/timelines` and
`/profiles/{username}` genuine server-rendered reading surfaces.

`TimelineUpdates` is stricter: it refuses **every type but PUBLIC** without a
username.

```go
if timelineType != model.TimelineTypePublic && username == "" {
    return nil, errors.New("authentication required for this timeline type")
}
```

So the Instance tab (LOCAL) reads fine for a signed-out visitor and **cannot go
live for them**. `realtimeAvailability` returns `requires-auth` there, and the
live strip says "Sign in to see this timeline update live" rather than showing a
spinner on a socket lesser will refuse. `readRequiresAuth` and
`realtimeAvailability` are two functions rather than one flag precisely because
the two answers differ.

### 2. `excludeAgents` filters after pagination

`timelineObjectEdges` drops agent-authored objects from the edges it returns,
while `hasNextPage` comes from the pre-filter cursor. A page of three when
twenty were requested says **nothing** about whether more exist. Only
`pageInfo.hasNextPage` decides the end of a timeline; nothing in contentus
infers it from page length.

### 3. `totalCount` is the page length

```go
TotalCount: len(edges),
```

Not a total. No contentus document selects it — a field that cannot mean what
its name says is safer absent than explained, because the explanation does not
travel with the value.

### 4. Viewer state is `Boolean!`, so anonymous callers get `false`

`ViewerFavourited` returns `false` the moment there is no username in context:

```go
viewerUsername := getUsernameFromContext(ctx)
if viewerUsername == "" || obj == nil || strings.TrimSpace(obj.ID) == "" {
    return false, nil
}
```

That `false` means **"there is no viewer"**, not "this viewer has not favourited
it". The two are different claims and lesser's schema cannot distinguish them,
because the field is non-nullable.

`toTimelineStatus` therefore takes `viewerAuthenticated` and omits
`favourited`/`bookmarked`/`pinned`/`reblogged` entirely when it is false, so the
action bar renders neutral rather than asserting a state nobody holds. This is
M2d's honest-states rule applied to a field the contract cannot express as
unknown.

### 5. Cursors are status ids, and live items have none

`Cursor: model.Cursor(note.StatusID)`, and `timelineUpdates` yields a bare
`Object!` rather than an edge. So a realtime-prepended status carries no cursor,
and pagination continues from the last **paged** cursor rather than from
anything the socket delivered.

### 6. Visibility spells followers-only `FOLLOWERS`

lesser's enum is `PUBLIC | UNLISTED | FOLLOWERS | DIRECT`; the vendored card's
is Mastodon's `public | unlisted | private | direct`. The projection composes
`normalizeVisibility` with `fromLesserVisibility` rather than calling the latter
alone: `fromLesserVisibility` widens an unrecognised value to `public`, which is
right where it was written (seeding a form control) and wrong here — this value
becomes the badge on somebody's post, and labelling a reach the client failed to
parse as "public" is how a followers-only status gets shown as world-readable.

### 7. The subscription transport

`docs/api-reference.md` → "GraphQL subscriptions (WebSocket)":

- endpoint `wss://ws.<stage-domain>` — the **root** of the WebSocket domain
- the `graphql-transport-ws` subprotocol
- auth in the `connection_init` payload; query-string tokens are ignored

This is a **different surface** from lesser's Mastodon-style streaming API at
`wss://ws.<stage-domain>/stream`, which takes `{type:'subscribe', stream}`
frames. The vendored `src/lib/transport.ts` speaks the latter, so face 4 does
not use it.

## Decisions

### `graphql-ws` was tried and rejected

lesser's own example names the `graphql-ws` npm package, so declaring it looked
like the contract-following move. It is not: declaring it hoists a second copy
of `ws` and **moves the SEC-2 advisory path** pinned in
`gov-infra/planning/contentus-disclosed-upstream-findings.json` from
`.>@equaltoai/greater-components-adapters>graphql-ws>ws` to
`.>@equaltoai/greater-components-adapters>viem>ws`. Perturbing an open
high-severity advisory's disclosed shape to add a client for a protocol
contentus needs a few hundred bytes of is a bad trade.

`src/lib/timelines/subscription.ts` speaks the documented framing over the
browser's native WebSocket instead — the same call `cms/graphql.ts` already
makes against Apollo for queries, for the same stated reason. The endpoint, the
subprotocol and the auth placement are all lesser's; only the socket is ours,
and `tests/timeline-subscription.test.mjs` drives every frame.

### The vendored lesser mapper is not used

`greater/adapters/mappers/lesser/mappers.ts` → `mapLesserObject` hardcodes:

```ts
favourited: false,
reblogged: false,
bookmarked: false,
pinned: false,
```

It never reads lesser's `viewer*` fields at all, so a signed-in reader's own
favourites would render un-favourited. `mapLesserPost` reads
`post.userInteractions.*`, which is not lesser's GraphQL shape either. Face 4
projects lesser's `Object` directly instead. **Routed upstream.**

### `Timeline.LoadMore` could not be used

It calls `getTimelineContext()`, which throws outside `Timeline.Root` — and
`Timeline.Root` is not a passive provider: it renders its own
`<div role="feed" onscroll>` with its own infinite-scroll trigger, while
`TimelineVirtualized` renders its own scroll region containing its own
`role="feed"`. Nesting them gives two feed roles and two load-more triggers on
one list. The two vendored timeline stacks do not compose. `EmptyState` and
`ErrorState` take no context and are used as they are; the load-more control is
contentus's. **Routed upstream.**

### The CSP addition

FaceTheory's strict policy is `connect-src 'self'`, which was right for every
surface before face 4. lesser's GraphQL subscriptions are served from a sibling
host, so without an addition the browser blocks the socket before it opens.

The addition is one origin, **derived** from the request that was served rather
than configured, added **only** on `/timelines`, and touching nothing else — no
`script-src`, no `style-src`, no `unsafe-*`. `/profiles/{username}` opens no
socket (`timelineUpdates` takes a type and a listId, not an actor) and gets no
widening. A request with no trusted forwarded host gets none either, because
`resolveRequestOrigin` fails closed and this fails closed with it.

## Routed upstream

### To `equaltoai/greater-components`

1. **`ContentRenderer` emits nothing during SSR** — the blocking one.
   `ContentRenderer.svelte` writes its sanitized output through a Svelte action
   (`use:setHtml` → `node.innerHTML`). Actions do not run during SSR, so the
   server emits `<div class="content"></div>` and **no status body
   server-renders on any social path** — `StatusCard` and `Status.Content` both
   reach it. The blog face's `Article.Content` uses `{@html}` and renders
   correctly, so this is one component's defect rather than a framework limit.
   Suggested fix: emit `{@html processedContent}` as the blog face does, keeping
   the action for the client-side update path.

   Contentus cannot repair this locally. Vendored source is never hand-edited,
   and an `{@html}` in contentus-owned source is exactly what check 3 of
   `scripts/audit-renderer-authority.mjs` forbids; weakening that gate to route
   around an upstream bug is the repair that is never correct. The gap is
   therefore **pinned** by `tests/ssr-timelines.test.mjs`, which fails the day it
   is fixed, and disclosed in a `<noscript>` block to the readers it reaches.

2. **`mapLesserObject` fabricates viewer state** — hardcodes four viewer fields
   to `false` and never reads lesser's `viewer*` fields.

3. **`Timeline.LoadMore` cannot be composed with `TimelineVirtualized`** — see
   above. Either `LoadMore` should tolerate an absent context, or the two stacks
   should share one.

4. **CLI: `greater add` still rewrites consumer `package.json`**
   (greater-components#918, third reproduction). At M4 it added thirteen
   dependencies nothing in the emitted tree imports, including the Markdown
   rendering chain contentus refuses. The dependency list is a union of registry
   metadata rather than a function of the emitted imports; walking every bare
   specifier in the files this run wrote yields exactly one package.

5. **CLI: `--css-only` is not CSS-only.** `greater add faces/social --css-only
--dry-run` still resolves the face's registry dependencies and reports nine
   component files across three target directories, including the `admin` shared
   module and three patterns. This is what forced `src/lib/brand/timelines.css`
   rather than consuming upstream's own theme.

6. **Registry records still ship no per-module CSS** (the M3 finding, unchanged).
   `timeline`, `social-status-card`, `social-timeline` and `profile` all emit
   classes defined only in the un-installed social face theme.

### To `equaltoai/lesser`

1. **No contract-served GraphQL subscription endpoint.**
   `InstanceInfo.streamingUrl` looks like the field for it and is not — it
   resolves to `r.Config.BaseURL()`, the instance's HTTP origin, where
   Mastodon's `urls.streaming_api` is the WebSocket URL. Clients therefore have
   to derive `wss://ws.<host>` from a documented topology convention rather than
   read a value the instance stated. Ask: publish the subscription endpoint on
   `InstanceInfo` (or make `streamingUrl` the WebSocket URL, as Mastodon parity
   would suggest).

2. **Timeline errors carry no extension codes.** The resolvers return plain
   `errors.New` values, so `classifyTimelineFailure` matches on message text to
   tell "sign in" from "not found" from "unavailable" — three genuinely
   different screens. Ask: an `extensions.code` on the timeline and actor
   resolvers' errors.

3. **`timelineUpdates` accepts a `listId` it does not forward.** The resolver
   validates that `listId` is present for LIST and then calls
   `sm.SubscribeToTimelineUpdates(ctx, username, timelineType)` without it.
   Out of face 4's scope (contentus surfaces no list timelines yet) but recorded
   while it was in view.
