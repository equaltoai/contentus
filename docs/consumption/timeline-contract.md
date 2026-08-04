# Face 4 — consuming lesser's timeline contract

What contentus learned reading lesser's timeline surface for M4, what it does
about each fact, and what it routed upstream instead of working around.

Verified against lesser at `graph/core.graphql`,
`graph/query_resolvers_notes.go`, `graph/subscription_resolvers_timelines.go`,
`graph/object_viewer_interactions_resolvers.go`,
`graph/query_resolvers_instance_parity.go` and `docs/api-reference.md`; against
greater-components at `greater-v0.12.0` (`c9825f8f`), which was the vendored pin
when face 4 was written. The vendored tree has since moved to **greater-v0.13.0**
(`ce8f3d9d`) at the M6 bump; this record is what was read at v0.12.0, not a claim
about the current pin.

## Contract facts that changed the UI

### 1. Auth is per timeline type, and there are THREE answers, not two

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

And the **WebSocket gateway in front of that resolver is stricter still**, which
is the answer readers actually meet. `cmd/graphql-ws/main.go` →
`handleConnectionInit` refuses every `connection_init` with no access token,
_before any GraphQL dispatch_:

```go
tokenValue := extractAccessTokenFromInitPayload(msg.Payload)
if tokenValue == "" {
    log.Warn("connection_init missing access token")
    _ = s.sendJSON(wsCtx, responseEnvelope{
        Type: "connection_error",
        Payload: errorPayload{
            Message: "Access token required in connection_init payload",
            Code:    "unauthorized",
        },
    })
    return okWebSocketResponse(), nil
}
```

`handleSubscribe` then refuses again for any connection with no username. So the
resolver's PUBLIC-anonymous allowance is **unreachable through the gateway**, and
that contradiction is filed against lesser (below). Until it resolves,
`realtimeAvailability` gates realtime on a token for **every** type: the
timelines read for everyone and go live for signed-in readers, and the live strip
says "Sign in to see this timeline update live" rather than advertising a stream
that cannot open. `readRequiresAuth` and `realtimeAvailability` are two functions
rather than one flag precisely because the two answers differ — and reads are
untouched by the realtime gate, which
`tests/timeline-contract.test.mjs` asserts as a pair.

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
like the contract-following move. It is not, and the reason that still holds is
the small one: contentus needs a few hundred bytes of the protocol, not a client
library, and a smaller surface is a smaller thing to get wrong.

_Historical, and no longer a reason:_ at M4 declaring it also hoisted a second
copy of `ws` and **moved the SEC-2 advisory path** then pinned in
`gov-infra/planning/contentus-disclosed-upstream-findings.json` from
`.>@equaltoai/greater-components-adapters>graphql-ws>ws` to
`.>@equaltoai/greater-components-adapters>viem>ws` — perturbing an open
high-severity advisory's disclosed shape to add a client nothing needed. That
advisory (GHSA-96hv-2xvq-fx4p) was **retired at the greater-v0.13.0 pin bump**,
whose adapters resolve `ws@8.21.0`, and the SEC-2 disclosed set is now empty.
The decision stands on its own merits rather than on an advisory that is gone.

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

### The feed's collections are bounded by refusing to grow, never by evicting

`/timelines` is a route a reader can leave open for hours with a socket
delivering into it, so both backing collections are capped:
`MATERIALIZED_LIMIT` (500) on the rendered list, `LIVE_BUFFER_LIMIT` (200) on the
live buffer, and `FEED_LIMIT` (700) on the two together — the last because
buffering and revealing moves statuses from one into the other and empties the
buffer, so a reader who scrolls away and back repeatedly grows the rendered list
by a full buffer each cycle while both individual caps still hold. The strict
bound on the rendered list is therefore `500 + 20 + 200 = 720`: the cap, the page
that was in flight when it was crossed, and one last buffer revealed on top.

**No cap is enforced by dropping something already held**, and that constraint
comes from the cursor. `endCursor` is the cursor of the last status a page
delivered, so evicting the tail and then paginating from that cursor appends
posts contiguous with something no longer on screen — a hole in the middle of the
timeline that nothing marks. (Fact 5 above notes that lesser's cursor _is_ the
status id today, which would make a tail-derived cursor work; that is an
implementation detail this client has no contract for and will not build a bound
on.) So growth stops and the stop is disclosed: the load-more control becomes a
bound notice, and an overflowed buffer becomes a refresh prompt rather than a
count. A stop is a state a reader can act on; a hole is not.

The rules live in `src/lib/timelines/feed-state.ts` rather than in the component
so `tests/timeline-feed-state.test.mjs` can drive them directly — which is how
the missing `FEED_LIMIT` was found, by an adversarial probe that reached 940
items against a module whose two per-collection caps were both satisfied.

### A partial GraphQL failure is carried, not discarded

GraphQL answers a half-failed request with **both** data and errors, and this
client's timeline document selects nullable fields — `boostedObject` above all.
A field that failed comes back as `null` beside its error, which is
indistinguishable from a field that was legitimately null: a post whose boost
could not be resolved renders as a post that was never a boost.

`fetchTimelinePage` and `fetchActor` therefore return `partial: boolean`
alongside the data, and the feed renders a designed notice for it — distinct from
the `skipped` count, which is about objects _this client_ could not project
rather than fields _the instance_ could not resolve. No server text reaches the
reader: lesser's timeline errors carry no extension codes (filed below), so the
only honest thing a client can say from them is _that_ something failed.

**The marker travels through SSR, and originally did not.** Carrying it on the
wire is only half the job: contentus server-renders the first page of Instance,
Federated and every profile, so the server pass is the _only_ pass a reader with
no script gets and the first paint for everyone else. `TimelinesRouteData` and
`ProfileRouteData` therefore carry it (`partial`; `pagePartial` and
`actorPartial` on a profile, because the card and the posts are two reads that
fail independently), `TimelineFeed` seeds its state from `initialPartial` rather
than from `false`, and the profile card renders its own
`.contentus-profile__partial` notice. Found by codex's adversarial review of
PR #56: the transport was correct and `entry-server.ts` dropped the marker one
layer later, so a half-failed server read painted a timeline that asserted a
completeness lesser never claimed. A half-failed read that carried **no**
objects is disclosed too, rather than rendering as "no posts yet" — the false
empty this whole rule exists to prevent, arriving through the one state that had
no marker on it.

## Routed upstream

### To `equaltoai/greater-components`

1. **`ContentRenderer` destroys status bodies — twice, in two different ways.**
   The blocking one, and it is two defects in one component. The second was
   found by codex's adversarial review of PR #56 and is the worse of the pair,
   because it hits readers who have JavaScript — i.e. everyone.

   **1a. Nothing server-renders.** `ContentRenderer.svelte` writes its sanitized
   output through a Svelte action (`use:setHtml` → `node.innerHTML`). Actions do
   not run during SSR, so the server emits `<div class="content"></div>` and **no
   status body server-renders on any social path** — `StatusCard` and
   `Status.Content` both reach it. The blog face's `Article.Content` uses
   `{@html}` and renders correctly, so this is one component's defect rather than
   a framework limit.

   **1b. What hydration fills in is escaped.** `processContent` sanitizes the
   HTML and then, when the status carries **no mentions and no tags**, passes the
   sanitized _markup_ to `linkifyMentions`, whose first line escapes it:

   ```ts
   // ContentRenderer.svelte:145-152
   if (mentions.length === 0 && tags.length === 0) {
       processed = linkifyMentions(processed, { … });
   }

   // utils/linkifyMentions.ts:106
   let result = escapeHtml(text);
   ```

   The escaped string is then assigned to `node.innerHTML`. Exact reproduction:

   | Input (lesser's sanitized HTML)       | What the reader sees                                   |
   | ------------------------------------- | ------------------------------------------------------ |
   | `<p>Hello <strong>world</strong></p>` | the literal text `<p>Hello <strong>world</strong></p>` |

   `linkifyMentions` is a **plain-text** helper — escaping its input is correct
   for the job it was written for — and the component hands it HTML. A status
   that _does_ carry mentions or tags takes the other branch and renders
   correctly, which is why the defect survives casual inspection: it hits
   ordinary posts and spares the ones with an `@` or `#` in them.

   **That bound is pinned too**, on codex's second look at PR #56. The feed's
   disclosure claims _some_ posts, and an unpinned bound is a claim that decays
   silently: the vendored mentions branch could start escaping too with every
   probe still green, and the disclosure would go on saying "some" while every
   post was corrupt. `tests/vendored-content-renderer.test.mjs` now **executes
   the component's real `processContent`** — the region is sliced verbatim out of
   the `.svelte` file and evaluated, because the function is an instance closure
   that cannot be imported and the component writes through an action that needs
   a DOM to run — and drives one body through both branches. Reproducing the
   pipeline in test code, which is what it did before, agrees with itself no
   matter what the vendored file says.

   Suggested fix for both: emit `{@html processedContent}` as the blog face does
   (keeping the action for the client-side update path), and stop routing
   already-sanitized HTML through the plain-text linkifier — or give
   `linkifyMentions` an HTML-aware mode that linkifies text nodes only.

   Contentus cannot repair either locally. Vendored source is never hand-edited;
   an `{@html}` in contentus-owned source is exactly what check 3 of
   `scripts/audit-renderer-authority.mjs` forbids; and **there is no supported
   prop that skips the linkify step** — the component's whole `Props` surface is
   `content`, `spoilerText`, `collapsed`, `mentions`, `tags`, `mentionBaseUrl`,
   `hashtagBaseUrl`, `class`, `onToggle`, and the only prop-driven escape is
   supplying non-empty `mentions`/`tags`, which are content lesser states rather
   than a rendering switch. Fabricating them to steer a branch would be inventing
   content to route around a rendering bug. So both gaps are **pinned** —
   `tests/ssr-timelines.test.mjs` for 1a and
   `tests/vendored-content-renderer.test.mjs` for 1b, each corrupting branch
   asserted invertedly so it fails the day upstream fixes it — and **both are
   disclosed in the feed**:
   the always-rendered `.contentus-feed__gap` notice for the hydrated corruption
   (which a `<noscript>` block would never reach) and the `<noscript>` block for
   the missing server paint.

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

1. **The subscription gateway and the subscription resolver contradict each
   other, and the contradiction is a dead UI.** The blocking one. Verified at
   lesser `11c1622f`.

   `graph/subscription_resolvers_timelines.go:66` permits an **anonymous PUBLIC**
   `timelineUpdates` subscription — it refuses only `type != PUBLIC` with no
   username. `cmd/graphql-ws/main.go:715-754` never lets such a caller reach it:

   ```go
   tokenValue := extractAccessTokenFromInitPayload(msg.Payload)
   if tokenValue == "" {
       _ = s.sendJSON(wsCtx, responseEnvelope{
           Type: "connection_error",
           Payload: errorPayload{
               Message: "Access token required in connection_init payload",
               Code:    "unauthorized",
           },
       })
       return okWebSocketResponse(), nil
   }
   ```

   `handleSubscribe` then refuses a second time for any connection whose
   `state.username` is empty. So **every** anonymous subscription is rejected
   before GraphQL dispatch, and the resolver's PUBLIC allowance is unreachable
   through the only transport that serves it.

   Three separate asks, in the order they cost:

   - **The behaviours disagree.** Either the gateway should let a tokenless
     connection through and leave authorization to the resolver (which already
     does it, per type), or the resolver's PUBLIC-anonymous branch is dead code
     and the contract should say realtime requires auth. Contentus has assumed
     the second and gated realtime on a token for every type; the day the first
     ships, `tests/timeline-contract.test.mjs` goes red and PUBLIC comes back.
   - **`connection_error` is not a `graphql-transport-ws` frame.** It belongs to
     the older `subscriptions-transport-ws` protocol, while the handshake
     negotiates `graphql-transport-ws` (`graphqlTransportWSSubprotocol`, echoed
     back at `main.go:571-578`). A spec-conformant client — including the
     `graphql-ws` npm package lesser's own docs recommend — has no case for it.
     The spec's answer for a refused handshake is a socket close with **4401**.
   - **The socket is left OPEN after the refusal.** `handleConnectionInit`
     returns `okWebSocketResponse()` without disconnecting, so a client that
     ignores the unknown frame waits forever for a `connection_ack` that will
     never arrive. That is what contentus shipped at `2348b84`: the live strip
     read "Connecting…" indefinitely, for anonymous readers and for expired
     tokens alike (`"Invalid or expired token"` takes the same path).

   Contentus now handles `connection_error` explicitly — mapping `unauthorized`
   to a designed sign-in state and anything else to unavailable, and closing the
   session either way — so no reader meets the stall. That is a client working
   around a server contradiction, and it should be deleted when the contradiction
   is resolved rather than becoming the shape other clients copy.

2. **No contract-served GraphQL subscription endpoint.**
   `InstanceInfo.streamingUrl` looks like the field for it and is not — it
   resolves to `r.Config.BaseURL()`, the instance's HTTP origin, where
   Mastodon's `urls.streaming_api` is the WebSocket URL. Clients therefore have
   to derive `wss://ws.<host>` from a documented topology convention rather than
   read a value the instance stated. Ask: publish the subscription endpoint on
   `InstanceInfo` (or make `streamingUrl` the WebSocket URL, as Mastodon parity
   would suggest).

3. **Timeline errors carry no extension codes.** The resolvers return plain
   `errors.New` values, so `classifyTimelineFailure` matches on message text to
   tell "sign in" from "not found" from "unavailable" — three genuinely
   different screens. Ask: an `extensions.code` on the timeline and actor
   resolvers' errors.

4. **`timelineUpdates` accepts a `listId` it does not forward.** The resolver
   validates that `listId` is present for LIST and then calls
   `sm.SubscribeToTimelineUpdates(ctx, username, timelineType)` without it.
   Out of face 4's scope (contentus surfaces no list timelines yet) but recorded
   while it was in view.
