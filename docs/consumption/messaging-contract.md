# Face 5 — consuming lesser's conversation contract

What contentus learned reading lesser's direct-message surface for M5, what it
does about each finding, and what is routed upstream instead of worked around.

Written for the next person to touch `/messages`. Every claim here is either
asserted by a probe in `tests/` or marked as unverified against a live
instance — the trenchcoat dev instance is unreachable (no DNS) at the time of
writing, so nothing below rests on a round trip that did not happen.

---

## Contract facts that changed the UI

### 1. `unread` is a BOOLEAN, and there is no message count anywhere

`conversations` selects `unread: Boolean` per conversation. There is no
`unreadCount`, no per-conversation message total, and `conversationMessages`
carries `totalCount` for the WHOLE thread rather than for its unread tail.

So a client cannot honestly say "3 unread messages" about anything. What it can
say is how many conversations have unread activity, and that is what every
count in contentus does:

- the conversation card shows a **dot**, not a numeral — a "1" there reads as a
  message count, and it would be one contentus made up;
- the nav badge counts CONVERSATIONS, and its accessible label says
  `"N conversations with unread messages"` (`unreadBadgeLabel`);
- `unreadConversationCount` is the single place the total is derived.

greater's own `UnreadIndicator` sums the same per-conversation values under an
`aria-label` reading `"N unread messages"`. That mislabel is **routed
upstream**; contentus renders its own badge rather than shipping the wrong unit
to a screen reader.

Asserted in `tests/messaging-adapters.test.mjs` → _"unread is a
per-conversation boolean, and every count says conversations"_.

### 2. `conversations` accepts a cursor it never issues

The operation signature is `conversations(folder, first, after: Cursor)`. The
selection returns a **bare list** — no `pageInfo`, no `edges`, no per-item
cursor. So `after` is undrivable: there is no value any client could obtain to
pass back.

The consequence is not cosmetic. `first` is not "the first page", it is **the
whole list a reader can reach**. Contentus asks for 50 (`CONVERSATION_PAGE_SIZE`)
and ships no "load more" control on the list, because a control that cannot
advance is worse than none. A reader with more than 50 conversations cannot
reach the rest, and that is a real limit rather than a rendering choice.

Contentus deliberately does not send `after`. **Routed upstream** as an ask for
a proper connection. Pinned by `tests/messaging-queries.test.mjs` → _"the
conversation list document sends no cursor, because lesser returns none"_, which
fails if upstream ever adds `pageInfo` — at which point contentus should
paginate.

### 3. `conversationMessages` IS a proper connection

Unlike the list, the thread has `edges { cursor node }`, `pageInfo { hasNextPage
endCursor }` and `totalCount`. Cursor pagination for the thread (#34) is
therefore possible — through contentus's own read. See finding 7 below for why
the vendored handler cannot do it.

### 4. Edge order is unstated, so the client imposes one

lesser's schema does not say whether `conversationMessages` returns oldest- or
newest-first. The components render `state.messages` in array order and append
newly sent messages to the end, so a descending page would render a thread
upside down and put a reply above the message it answers.

`toMessagePage` sorts by `createdAt` ascending, with the server's own order as
the tiebreak. That is correct under either server order rather than a bet on
one. It is worth revisiting — and removing — if lesser ever states the order.

### 5. `conversationUpdates` publishes an id and nothing else

```graphql
subscription {
  conversationUpdates {
    id
  }
}
```

No message, no request state, no participant. Every event is a **signal to
re-read**, not data to render, which is why `handlers.ts` fetches the named
conversation on each event.

Two consequences the UI inherits and cannot paper over:

- a burst of messages arriving between two events collapses into one
  `lastStatus`, so only the most recent shows in the list row — the thread's
  own history read is what fills the gap;
- an event for a conversation whose re-read fails is dropped, and the socket
  stays open rather than tearing down.

Pinned by `tests/messaging-queries.test.mjs` → _"the subscription payload is
still id-only"_, which fails if lesser starts publishing the message, at which
point the re-read becomes unnecessary.

### 6. `sendMessage` returns the message AND the conversation

`sendMessage(...) { message { … } conversation { … } }`. Contentus selects both:
the message goes into the thread, and the conversation carries the updated
`updatedAt` and `viewerMetadata` that keep the list row in order.

A send whose `message` comes back null is **not** reported as sent. The composer
clears its input on a resolved promise, so resolving here would tell a reader
their message was delivered by moving the UI on.

### 7. Request state lives only in `viewerMetadata`

`viewerMetadata { requestState requestedAt acceptedAt declinedAt }` is the whole
request contract, and `requestState` is the only thing that decides:

- which folder a conversation is in (`folderForRequestState`, one derivation,
  one place);
- whether the card shows Accept/Decline;
- whether the composer is writable.

Nothing in contentus infers request state from an empty message list, an
unknown participant, or the folder a conversation arrived under. Crucially,
`acceptMessageRequest` returns the conversation carrying its NEW state, and
contentus reads that rather than assuming the accept worked — if lesser says
still pending, the card stays in Requests. Asserted in
`tests/messaging-adapters.test.mjs` → _"accepting reads the returned request
state rather than assuming it moved"_.

### 8. `createConversation` takes ONE participant

`createConversation(participantId: ID!)` — singular. DMs are 1:1 in v1.
`onCreateConversation` refuses a multi-participant request **before the wire**
rather than sending the first id and dropping the rest, which would hand a
reader a group they thought they had made.

### 9. Local and remote actors are keyed differently

Mirrored from greater's `getCanonicalParticipantId`, because lesser's mutation
resolvers match on it: a **remote** actor is named by its full actor id, a
**local** one whose id is `/users/<username>` by the bare username. The original
id is kept as `actorId` so own-message detection works against a session holding
either representation. Getting this wrong opens a conversation with the wrong
person, or with nobody.

---

## Decisions

### `createLesserMessagesHandlers` was tried and could not be used

The milestone names greater's adapter binding as face 5's wiring. It was the
first thing attempted and it does not compose with this client.

Its config type is `{ adapter: LesserGraphQLAdapter }` — the **concrete
Apollo-bound class**, not the structural surface it calls. It only ever touches
seven methods (`query`, `mutate`, `getConversations`, `getConversation`,
`markConversationAsRead`, `search`, `subscribeToConversationUpdates`), and a
contentus-shaped object implementing exactly those was built and passed to it.
That works at runtime. It does not typecheck: importing the module drags
`@apollo/client`, `graphql` and `@graphql-typed-document-node/core` into
contentus's typecheck graph through the `import type` chain, and those packages
are not installed. `pnpm run svelte-check` went from 0 errors to 51, every one
of them in a vendored file contentus is not allowed to edit.

The three ways to make them resolve were each refused:

| Option                       | Why refused                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install `@apollo/client`     | Adds a second GraphQL client to a client that posts one document per action, and pulls `graphql-ws` — which MOVES the SEC-2 advisory path pinned in `gov-infra/planning/contentus-disclosed-upstream-findings.json`. M4 weighed that exact trade and declined it. |
| Declare ambient module stubs | A fake contract state. `AGENTS.md` refuses these outright, and a wrong stub masks real type errors.                                                                                                                                                               |
| Suppress the errors          | The gate would report a colour it had not earned.                                                                                                                                                                                                                 |

So `MessagesHandlers` — **the interface the vendored COMPONENTS define**, in
`components/messaging/context.svelte.ts` — is implemented directly in
`$lib/messaging/handlers`. The components themselves (`Root`, `Thread`,
`Composer`, `Message`, `NewConversation`, and the `createMessagesContext` state
machine) are used exactly as they ship, so the contract between contentus and
the suite is still upstream's and a pin bump that changes it fails the
typecheck.

**This is a deliberate divergence from the milestone brief and is reported as
one.** The coupling is routed upstream below.

### The documents are hand-authored, and pinned by probe

Following from the above: owned source cannot import
`greater/adapters/graphql/generated/types.ts` either. So `$lib/messaging/queries`
authors every document, the same call `$lib/timelines/contract` makes for face
4's `TIMELINE_QUERY`.

Hand-authoring is only safe if something notices when upstream moves, so
`tests/messaging-queries.test.mjs` imports the **real generated ASTs** — a probe
may, being outside the typecheck graph — prints them, and asserts contentus asks
for the same operations with the same root fields, argument names and variable
types, and selects every field the mappers dereference. Three deliberate
mutations were run against it during development (a renamed argument, a
nullability change, a dropped field); each failed the matching assertion.

Contentus's selections are deliberately **narrower** than upstream's:
greater's `ObjectFields` carries poll state, quote context and community notes
that no messaging component reads. Asserting string equality would fail on a
difference that is the point.

### `Messages.Conversations` is not used; the list is contentus's

The one component of the suite that could not serve the design, for two
independent reasons:

1. It bundles a header, a folder tab bar and the cards into one component with
   no slots, and its tabs call `fetchConversations` directly — there is no prop
   saying which folder to open. `?folder=requests`, a Requests tab a reader can
   **link somebody to**, is unreachable through it.
2. Its card is a `<button>` with no action slot, and §5 puts accept/decline **on
   the card**. No prop, snippet or child adds one.

`ConversationList.svelte` and `MessagesFolderTabs.svelte` compose over the SAME
`getMessagesContext()` the vendored components read, so they share its state,
handlers and realtime updates rather than running a second model beside them.
Both gaps are **routed upstream** as asks.

### The false-empty fix lives at the adapter boundary

greater's `getConversations` ends `Array.isArray(conversations) ? conversations
: []`. A read that FAILED — data null, errors present — therefore returns an
empty list, and the surface renders "No messages yet" to somebody who has
messages. M2d settled that failed and partial reads render unknown/unavailable
and never a false empty.

`adapter.fetchConversations` **throws** where upstream returns `[]`, and the
same rule is applied to `search.accounts` (an absent list is not "nobody
matched"). An empty list lesser genuinely returned still passes through, because
a real empty inbox must still render as empty — the check is on presence, not
length.

### A partial GraphQL failure is carried, not discarded

Same rule, and the same reason, as M4's `TimelineResult.partial`: lesser answers
a half-failed read with both data and errors, and the objects it did return are
worth showing. The surface shows them AND says something is missing, rather than
asserting a completeness lesser never claimed.

### Realtime states are kept distinct rather than flattened

The messages context has three realtime states (`connected`, `disconnected`,
`error`). The socket has seven. The distinctions that matter to a reader —
`requires-auth` (sign in again) versus `unavailable` (reload) versus `degraded`
(the stream is open but something it sent could not be read) — are tracked
separately by the surface, because collapsing them produces one sentence for
three different actions. `requires-auth` carries the M4 session-expired copy:
lesser's gateway answers an expired credential with `connection_error`, and a
reader who cannot tell that from a dropped socket has no idea signing in would
fix it.

### The thread is its own route, and the URL always names what is on screen

`/messages` is the list; `/messages/{conversationId}` is a conversation. Above
960px both routes render both panes; below it they collapse and a conversation
PUSHES as its own address with a back affordance (§5). Cards are real links, so
they work before hydration, open in a new tab, and give the browser's own back
button the job.

### Nothing about a conversation travels from the server

The strictest instance of the rule `/review` follows. Every conversation
operation needs a bearer token, the session lives in `sessionStorage`, and route
props are serialized **verbatim into contentus's public hydration endpoint**. A
server-side `conversations` or `conversationMessages` fetch would put private
correspondence behind a URL anyone could request — worse than the draft case,
because unlike a draft there is no version of a DM that was ever meant to be
public.

The server ships the route, its folder and the conversation id. Asserted in
`tests/ssr-messages.test.mjs`: no outbound request at all on the server pass, no
`Authorization` header, no conversation/participant/message in the document,
`no-store` + `noindex` on every messaging route.

---

## Routed upstream

### To `equaltoai/greater-components`

1. **`Messages.Message` and `Messages.Conversations` escape lesser's sanitized
   HTML.** The blocking one. `Object.content` is server-sanitized HTML — that is
   the renderer-authority contract — and the component renders it with
   `{message.content}`, Svelte's escaping interpolation:

   | Input (lesser's sanitized HTML)       | What the reader sees                                   |
   | ------------------------------------- | ------------------------------------------------------ |
   | `<p>Hello <strong>world</strong></p>` | the literal text `<p>Hello <strong>world</strong></p>` |

   The conversation list preview does the same via `getMessagePreview`. Same
   family as the `ContentRenderer` gap M4 pinned, in a different component, and
   pinned on **both** surfaces it reaches rather than the first one found.

   Contentus cannot repair it: vendored source is never hand-edited, an
   `{@html}` in owned source is what check 3 of
   `scripts/audit-renderer-authority.mjs` forbids, and the component's whole
   `Props` surface is `message`, `currentUserId` and `class` — no prop, snippet
   or child changes the sink.

   Suggested fix: render the body through a sanitizing HTML sink as the blog
   face's `Article.Content` does, rather than through the escaping
   interpolation.

   **Pinned** by `tests/vendored-messaging-render.test.mjs`, which compiles the
   REAL component with the REAL Svelte compiler and asserts on the `$.escape`
   sink the compiler emitted, then runs the REAL `escape` from
   `svelte/internal/server` to show the consequence. Every assertion is inverted
   — it describes the broken behaviour and fails the day upstream fixes it.
   **Disclosed** by the always-rendered `.contentus-messages__gap` notice.

2. **`createLesserMessagesHandlers` cannot be consumed without Apollo.** Its
   config takes the concrete `LesserGraphQLAdapter` while calling only seven
   methods on it. Every consumer that is not an Apollo application is locked out
   — not by the runtime, which is satisfied by any object with those seven
   methods, but by the type. Suggested fix: accept a structural interface
   (`LesserMessagesAdapter`) that `LesserGraphQLAdapter` satisfies. This is the
   single change that would let contentus use the binding the milestone names.

3. **`MessagesHandlers` has no by-id conversation read.** `onFetchConversations`
   works a folder at a time, and there is nothing that resolves one
   conversation. Any client routing a thread as its own address — which §5's
   mobile collapse requires — needs one. Suggested: `onFetchConversation(id)`.

4. **`onFetchMessages` discards the cursor.** It accepts `{ limit, cursor }` and
   returns `DirectMessage[]`, dropping `pageInfo.endCursor` and `hasNextPage`,
   so a caller can pass a cursor it has no way to obtain. Cursor pagination is
   unreachable through the interface. Suggested: return the page, or a
   `{ messages, endCursor, hasNextPage }` envelope.

5. **`getConversations` returns `[]` for a failed read.**
   `Array.isArray(conversations) ? conversations : []` turns a failure into a
   false empty. Suggested: propagate the failure and let the caller decide.

6. **`UnreadIndicator` labels conversations as messages.** It sums
   `conversation.unreadCount` — which upstream itself derives as `unread ? 1 :
0` — under `aria-label="N unread messages"`. The number is conversations.

7. **`Messages.Conversations` cannot be told which folder to open**, and its
   card has no action slot. See the decision above; both block §5's addressable
   Requests tab and its on-card accept/decline.

8. **The messaging registry entry ships no stylesheet.** Third reproduction of
   the same CLI shape after `compose` and `timeline`: the record lists
   `component`, `types` and `utils` files and no `styles` entry, while every
   `.messages-*`, `.message*` and `.new-conversation*` class lives only in
   `packages/faces/social/src/theme.css`. `src/lib/brand/messaging.css` is
   contentus's interim appearance layer, with a stated sunset.

### To `equaltoai/lesser`

1. **`conversations` accepts `after: Cursor` and returns no cursor.** The
   argument is undrivable and `first` is a hard ceiling on what a reader can
   reach. Suggested: make it a connection, consistent with
   `conversationMessages`.

2. **`conversationMessages` does not state its edge order.** Clients must guess
   or re-sort; contentus re-sorts. Suggested: document it, or state it in the
   schema description.

3. **`conversationUpdates` publishes only an id.** Every subscriber must issue a
   follow-up read per event, and a burst between events is unrecoverable from
   the event stream alone. Suggested: publish the message, or at minimum the
   conversation's new `updatedAt` and `viewerMetadata`.

4. **There is no per-conversation unread COUNT.** `unread: Boolean` is the whole
   contract, so no client can render the message count a badge conventionally
   implies. Suggested: `unreadCount: Int`.

5. **No contract-served subscription endpoint.** Unchanged from M4 and repeated
   here because face 5 inherits it: the socket host is derived by prefixing
   `ws.` onto the request origin, which is lesser's documented topology but not
   a value the instance states. Confined to `subscriptionEndpoint` so there is
   one place to delete.

---

## Not verified against a live instance

The trenchcoat dev instance has no DNS at the time of writing, so the following
are **unverified** and are stated as such rather than assumed:

- the DM round trip (send → appears in thread → appears in the other
  participant's list);
- accept/decline against a real pending request, including whether
  `acceptMessageRequest` returns the conversation already carrying `ACCEPTED`;
- realtime delivery over `wss://ws.<domain>`, including whether the gateway
  accepts the authenticated `connection_init` for this subscription;
- the actual edge order of `conversationMessages` (finding 4 above is defensive
  precisely because it could not be observed).

Everything else in this document is asserted by a probe under `tests/`.
