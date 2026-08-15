# Face 6 — how contentus consumes lesser's agent surface

What `/agents` and `/agents/{username}` read, what they refuse to infer, and
where greater M6a's vendored components replace the interim composition.

Companion to `renderer-authority.md`, `review-contract.md`,
`timeline-contract.md` and `messaging-contract.md`. Source of truth is lesser's
`docs/contracts/graphql-schema.graphql` and the resolvers named below; where
this document and lesser disagree, lesser is right and this is a bug.

## Operations

| Surface              | lesser operation                              | Auth                      |
| -------------------- | --------------------------------------------- | ------------------------- |
| `/agents`            | `agents(first, after, type, query, verified)` | anonymous                 |
| `/agents/{username}` | `agent(username)`                             | anonymous                 |
| "Agents you own"     | `myAgents`                                    | bearer token, client only |
| MCP addresses        | `Agent.mcpAccess`                             | anonymous (not redacted)  |
| A shared agent's MCP | `agent(username) { mcpAccess }`               | bearer token, client only |
| Capability badges    | `Agent.agentCapabilities`                     | anonymous                 |
| Trust state          | `Agent.verified`, `Agent.quarantine*`         | anonymous                 |

`agents(ownerUsername:)` is **not used**. lesser rejects it for anonymous
callers and, for authenticated ones, permits only the caller's own username
unless they are an admin (`graph/agent_resolvers_stubs.go`). As a control on an
anonymous-safe roster it is `myAgents` with more ways to be refused, and routed
through the roster's URL grammar a shared `?ownerUsername=` link would promise a
view its recipient cannot have.

Preferred field names throughout — `agentType`, `agentVersion`,
`agentCapabilities`. The `type` / `version` / `capabilities` aliases are
deprecated in lesser's schema; they would still resolve, and would still be
wrong.

## Four resolver behaviours the UI is built around

Read from the resolver rather than the schema, because none of them are visible
in the type definitions.

**1. Filters are applied after paging.** `Agents` fetches one page via
`ListAgents(limit, cursor)` and then applies `type` / `query` / `verified` to
what came back. Two consequences, both load-bearing:

- `totalCount` counts matches **within that page**, not across the instance. It
  is carried as `matchesOnThisPage` and labelled "on this page". A card reading
  "Agents 24" beside a Next link would assert a total lesser never stated.
- A filtered page can be **empty while `hasNextPage` is true**. "No agents match
  these filters" is said only when lesser reports no further pages; otherwise
  the empty state says matches may lie further along.

**2. Redaction is indistinguishable from data — so lesser says when it redacted.**
`redactGraphAgentPrivateFields` blanks `agentOwner` to null, `delegatedScopes`
to `[]`, and the soul fields to `UNBOUND` for anyone who is not the agent's
owner or an admin (v1.6.4, commit `7aad73d5a`). Rendering those would tell
every anonymous visitor that every agent has no owner and no scopes. The view
model omits them unless lesser says the viewer may see them: `viewerIsOwner` is
lesser's served `viewerCanSeePrivateFields` carried through, never inferred
from whether a token was sent or from the values themselves. One detail
document serves every viewer — anonymous `agent` reads are admitted (commit
`1df0358b8`) and answered with the redacted shape plus
`viewerCanSeePrivateFields: false`, so there is no anonymous/owner document
split and lesser decides visibility per viewer.

**3. `quarantineActive` is lesser's projection, not a date comparison.** It
comes from `QuarantineSummaryAt` against lesser's own clock. contentus never
recomputes it from `quarantineStart`/`quarantineEnd` — a client comparing dates
would disagree with the instance across a skew, and the instance is the one that
enforces the restriction.

**4. The whole surface is instance-gated.** `ensureAgentsEnabled` refuses every
agent field when `AllowAgents` is off. That is a designed state and renders as
one ("This instance does not offer an agent surface"), matched narrowly on
lesser's own wording so a quarantine message cannot be mistaken for it.

## MCP: what is stated and what is probed

These are different kinds of claim and the panel keeps them apart.

**Stated** — `Agent.mcpAccess`, in the server's paint, true whether or not
anything is reachable: `mcpURL`, `protectedResourceURL`,
`authorizationServerURL`, `registrationURL`, `scopes`, `guidance`. Not redacted
for non-owners, so a reader with no script gets every address they need.

**Probed** — two unauthenticated documents, fetched by the reader's browser and
reported only as what that request returned:

- `/.well-known/mcp.json` (lesser-body, served `WithBrowserCORS`) — server name
  and version, the capability map, and the **tool registry**.
- the protected-resource metadata document (RFC 9728).

The SSR pass makes neither. They would report the SSR host's reachability rather
than the reader's, and would make a cold page wait on a third host.

### The URLs are lesser's

simulacrum's `resolveMcpTransport` rebuilds the MCP URL client-side from the
page origin — `api.` host prefix, `/mcp/<actor>` path, the protected-resource
well-known beneath it. That is a copy of lesser's `pkg/auth/mcp_access.go`
(`BuildPublicMCPAccessBundle`, `canonicalMCPResourceBaseURL`), which is the
authority for exactly those strings, and lesser hands them to contentus
finished.

Exactly one value is derived: `/.well-known/mcp.json`, which `mcpAccess` does
not name. It hangs off the **origin of `mcpAccess.mcpURL`** — the host lesser
itself named — never off `window.location`, which is the app host and a
different origin. Deriving a well-known path beneath a stated host is a much
smaller claim than deriving the host.

### What a share grant conveys, and where the grantee reads it

A grant on an agent conveys **access to that agent's MCP**: the grantee connects
to the agent's MCP endpoint and signs in **as themselves**, with their own
account, and lesser records which grantee drove each agent action (`actedBy`).
It is not, and since M2.1 (equaltoai/contentus#92) is nowhere offered as, a
licence to act as the agent inside this CMS.

Both share panels say so in their own lede, because a reader sees one screen and
not both: the owner's `AgentSharingPanel` at the moment they decide to grant,
and the grantee's `AgentSharedWithMePanel` when they read what they hold.
`tests/agents-trust.test.mjs` holds both halves — that each panel names MCP
access, and that neither describes a grant as the ability to act as the agent.

The grantee's list reads `mcpAccess` through `AGENT_MCP_ACCESS_QUERY`, one read
per shared agent, dispatched under the grant list's abort signal and session
stamp. Three things about that document are deliberate:

- **It is narrower than `AGENT_DETAIL_QUERY`.** The surface sending it asks one
  question about somebody _else's_ agent, so it selects no `agentOwner`,
  `delegatedScopes` or `viewerCanSeePrivateFields`. Every extra field is one a
  later panel can start rendering without anyone deciding it should.
- **It is one read per agent, not a roster read.** lesser has no
  batch-by-username query for agents, and the roster's filters are applied after
  paging (above), so no single roster page can be trusted to contain every agent
  a caller was granted.
- **It is display, never provisioning.** `BuildPublicMCPAccessBundle` is
  documented as the client-neutral actor-scoped MCP access surface "that can be
  shown by agent UIs without provisioning connector state". contentus provisions
  no lease, no token and no connector state, and has no surface that could.

An `ok` read whose `mcpURL` is empty is the instance **stating** it publishes no
MCP endpoint for that agent. That is a served fact and renders as one; it is a
different sentence from a read that failed, and `sharedMcpAccess`
(`src/lib/agents/mcp.ts`) is where the two are kept apart. A grantee who reads
"none published" stops looking; one who reads a failure tries again.

The row shows the endpoint and links to the agent's own page for the rest of the
bundle. It deliberately does not reuse `CopyBlock`: that component sits behind
the `AgentMcpPanel` seam (`scripts/lib/agent-seams.mjs`), and greater M6a
replacing that panel must not orphan the grantee's list.

### Who holds access, and who held it

`GET /api/v1/agents/{username}/share` is lesser's **owner/admin view**, and it is
the only read on this contract that carries revoked entries at all.
`ListByAgent` runs `authorizeAgentOwner` before it reads anything and answers
everyone else `ErrNotAuthorized`
(`lesser/pkg/services/agentshare/service.go:142-149, 201-225`); the route sits
behind `requireManageAgents` and `authenticateAgentOwner` on top of that
(`lesser/cmd/api/routes.go:173`). The grantee-facing `shared-with-me` list is a
different index with `RevokedAt attribute_not_exists` filtered in at the query.
So the audit half is owner-only by lesser's construction, and no arrangement of
this client widens or narrows it.

What contentus owes is not to widen the READER. The one call site is
`AgentSharingPanel`, which `MyAgents` mounts only behind lesser's `agent.owner`
statement, and `tests/agents-trust.test.mjs` sweeps tracked source to assert
`listShareGrants` has no second caller.

The panel shows the two halves apart — **who has access now**, and **access that
was revoked** — with each entry's audit stamps: `granted_at`/`granted_by` on
both sides, `revoked_at`/`revoked_by` on the revoked one. The split is lesser's
own `active` boolean (`RevokedAt == nil`, computed server-side), never a
re-derivation from the timestamps, and an entry that arrives without that
boolean is placed on **neither** side and counted in a notice: filed under
current it would claim access the instance never confirmed, and filed under
revoked it would tell an owner someone's access is gone when it may not be.
`accessLedger` (`src/lib/agents/share-view.ts`) is where that classification
lives, and `tests/agent-share-view.test.mjs` exercises it directly.

**The exclusion reaches the empty state, which is a claim like any other.** An
empty current-access list is the instance's "nobody holds access" only when the
instance classified everything it sent; while an unclassified entry exists, that
same sentence answers for lesser about the one row that could be a live grant —
a 200 that dropped `active` from a real grantee's row would hide the row _and_
tell the owner the opposite of the only surviving claim
(equaltoai/contentus#100, codex review 4941340448). So the empty state states
what is known — nothing classified holds access — and names the entries whose
access could not be determined, in the same exclusion the counting notice
describes. A caveat appended to the certain sentence is not the fix and is
probed against: `noCurrentAccessStatement` composes both readings beside the
classifier, `tests/agent-share-view.test.mjs` calls them, and
`tests/agents-trust.test.mjs` holds the panel to rendering that statement rather
than a sentence written into the branch, where the unclassified count is not in
hand.

**The revoked list is not an event log, and says so on screen.** lesser keeps
one row per grantee, and `RegrantAgentShareGrant` `Remove`s that row's
`RevokedAt` and `RevokedBy`
(`lesser/pkg/storage/repositories/agent_share_repository.go:45-75`) — so
granting a revoked account again erases the revocation it followed. What the
list shows is where each account's access **stands**. The event-by-event
sequence is the agent activity log lesser writes beside each mutation
(`agent.share.grant`, `agent.share.revoke`, `service.go:227-259`), a different
read on a different surface, and M2.4's rather than this one's.

An audit stamp **drops a clause lesser did not serve rather than filling it**.
`revoked_by` is optional in the vendored contract and `revoked_at` is nullable,
so `grantStamp` composes from what arrived and degrades to the verb alone;
"by unknown", or the owner's own name standing in, would be this client
inventing the answer to the one question the screen exists to ask. lesser's
served order is kept within each half for the same reason — re-sorting by
`revoked_at` would order the list by a field that is not always there.

### Who has been driving the agent

M2.4 (equaltoai/contentus#95). The companion question to the one above, and a
different one: the grant ledger names the accounts that **could** reach the
agent, this names the people who **actually did**. The operator's words were
"knowing who was logged into MCP as it were".

**There is no session index, upstream or here.** Operator directive,
2026-08-13: _"I would not index who was logged into an MCP, but its important
metadata."_ Attribution rides the audit trail lesser#1401 landed
(`lesser` commit `a1ed548ea`): the agent stays in the audit row's `Username`
and the human who authorized the token rides in the row's metadata. So this
view answers who was connected **from what the agent did**, never from a record
of anyone being connected — and `AgentDriversPanel`'s lede says exactly that,
because a roster of names under a heading about being logged in reads as a list
of live sessions, which is the thing that was deliberately not built.

**The contentus-consumable surface is GraphQL**, so GraphQL-first applies with
nothing to except it. Unlike the share grants — REST because lesser puts them
on a management plane with no GraphQL spelling — the activity log is served
both ways: `GET /api/v1/agents/{username}/activity`
(`lesser/cmd/api/routes.go:180`) and the root field
`agentActivity(username, first, after)` (`lesser/graph/agents.graphql:993`,
present in the pinned schema). `activity-client.ts` uses the GraphQL one
through the same transport as every other contentus read.

**Owner-gated by lesser, and this client does not widen it.** The resolver
requires a caller, requires `read` scope, and answers `Forbidden` unless the
caller is the agent's owner, an admin, or the agent itself
(`lesser/graph/agent_resolvers_stubs.go:376-395`). The panel mounts behind
lesser's own `agent.owner` statement — the same gate as the sharing panel —
and sends the owner's own token.

**Two attribution keys, two mechanisms, and one row can carry both.**
`delegated_by` is written from the token's `DelegatedBy` claim
(`agent_audit.go:53`) and names the human who authorized the token — on a
shared agent's MCP, the grantee who signed in. `acted_by` is written on the
in-CMS act-as path (`agent_act_as.go:114`) and names that request's real
caller. `statuses.go:126-127` hands the **same** metadata map to both writers
in sequence, so the act-as row is marshalled with `delegated_by` already in it.

**On the shipped path a dual-key row names one human, not two**, and reading it
as two was this client's defect (codex review 4941720248 on PR #101).
`ResolveActAs` is handed no caller identity; it **derives** one from the same
claim the other writer used — `caller := ToLower(TrimPrefix(claims.DelegatedBy,
"@"))`, returned as `ActedBy` (`pkg/auth/agent_act_as.go:79-111`). So on every
dual-key row lesser writes, `acted_by` _is_ `delegated_by` with the sigil
stripped and the case folded. lesser's own round test pins the pair: an
agent-subject token with `DelegatedBy: "@alice"` plus `X-Lesser-Act-As` writes
`{"delegated_by":"@alice","acted_by":"alice",…}`
(`agent_act_as_round_test.go:157-193`). Rendering that unmerged printed
"@alice and @alice" and counted one action twice.

`actionDrivers` therefore merges the two keys when they name one identity, and
keeps them apart only when they genuinely name two people — a state the shipped
path cannot reach, but `metadataJson` is an unvalidated column any writer may
have filled, so two names stay two people. The merged row is labelled `act-as`:
only `recordActAsAuditEvent` writes `acted_by` and only a validated
`X-Lesser-Act-As` request reaches it, so that channel is certain, while
`delegated_by` rides every agent token whatever channel it came over. Nothing is
lost — a request carrying no act-as header writes a `delegated_by`-only row,
which still contributes `delegated` to that driver.

**Neither mechanism label names a channel its key does not prove.** The
`delegated_by` mechanism was called `mcp` and rendered "signed in to the agent's
MCP"; both are retired. `recordAgentAuditEvent` fires on **every** request
carrying agent claims (`agent_audit.go:16`), and an act-as request from a CMS
client carries an agent-subject token — so that row is written for callers who
never opened MCP, and the label told the owner they had signed in to it. The
member is now `delegated` and the sentence is "authorized the token the agent
acted under", which is what the key carries. The act-as label is unchanged: that
one is certain, because `acted_by` is written only behind a validated
`X-Lesser-Act-As`.

**The identity is compared case-insensitively, because lesser spells it both
ways.** `resolveAgentClaims` keeps the stored owner form "byte-for-byte"
(`pkg/auth/oauth.go:595-599`) while `ActedBy` is `ToLower`ed, so the same human
reaches this client as `@Alice` and `alice` — within one row, and across rows
(`interactions.go:349` and `misc.go:1806` pass no shared map, so those carry
`acted_by` alone). Folding case is lesser's own rule for these values, not a
liberty taken here: every identity comparison in `pkg/auth/agent_owner.go` is
`strings.EqualFold`. `driverLabel` decides the **sigil**, `driverKey` decides
the **identity**, and neither decides who the person is: the keys are spelled
differently at the source — `acted_by` is a bare username, `delegated_by` has
been through `normalizeDelegatedBy`, which prepends `@` (and prepends it to an
actor-URL owner too) — and an unrecognizable value is still shown as it arrived.

**What this surface does not provide**, recorded so a later consumer does not
render past a boundary it did not know about:

- **No session identity.** The writer puts the agent's session in the audit
  row's `SessionID` _column_, and `AgentActivityEvent` has no field for it —
  the resolver reads `ID`, `EventType`, `Metadata` and `Timestamp` and nothing
  else. This is the shape of the directive above, not a gap to route upstream.
- **A row is not a deed.** One act-as status create writes **two** rows:
  `statuses.go:126-127` calls both writers, and lesser's round test says so in
  its own words — "agent-subject requests emit both the agent audit event
  (`delegated_by`) and the act-as attribution event (`acted_by`)"
  (`agent_act_as_round_test.go:182-183`). The other act-as sites
  (`interactions.go:349`, `misc.go:1806`) call one writer and emit one row. So a
  driver's count is **rows naming them**, which the roster's own field comment
  says and which can exceed the number of things the agent did. This client does
  **not** collapse the pair: doing so would need an invented identity for "the
  same action" across rows — `(action, target_id)` is not one, since two genuine
  favourites of one status share it — and that is the same guess this module
  refuses when it declines to gloss `action`.
- **No login or token events.** The resolver keeps only event types prefixed
  `agent.` (`agent_resolvers_stubs.go:449`), so the `auth.oauth.*` records —
  token issued, refreshed, revoked — are filtered out server-side.
- **No window control.** The range is fixed at 30 days before now
  (`agent_resolvers_stubs.go:404`) with no argument to move it. The number is
  deliberately **not** asserted on screen: it is a server constant this client
  cannot read back, so putting it in the copy would be a claim that goes stale
  silently the day lesser changes it. The panel says "the activity it keeps".
- **`totalCount` is not a total.** The resolver assigns it `len(edges)` — the
  size of the page it just built — so the document does not select it. The
  honest count of one read is `edges.length`, and the boundary that matters is
  `pageInfo.hasNextPage`, which is selected and surfaced as older actions this
  view did not read.
- **`metadataJson` arrives unvalidated.** lesser hands back the stored column
  without parsing it (`agentActivityMetadataPtr`), so a value that will not
  parse is a state the contract permits and is classified `unreadable`.

**An empty roster is not an empty answer**, the M2.3 lesson on this surface.
"Nobody has driven this agent" is lesser's own statement only when it recorded
no actions at all. Actions that named no driver, and rows whose metadata could
not be read, are counted apart and get their own sentences from
`noDriverStatement` and `partialAttributionNotice` — composed beside the fold
whose exclusions they describe, and probed there, never a certain sentence with
a caveat bolted on.

**No upstream ask is opened by this milestone.** Everything M2.4 needed was
already reachable.

**And one was closed by it.** This section previously recorded ask G in
`docs/consumption/review-contract.md` as open and unaffected, on the reasoning
that `DraftReview.actedBy` concerns the **CMS review projection** — a different
surface from the agent audit trail — so this view could not substitute for it.
The first half is still true and the conclusion no longer follows. Ask G is
**retired** (2026-08-14, operator disposition at the close of the M2
realignment): its premise was a grantee reading the CMS review surface AS the
agent, which M2.1 removed. What remains of the underlying question — who
actually drove this agent — is answered by owner-only `Draft.actedBy` on the
workspace and by this view, and for a grantee by lesser's own record of the MCP
call they made as themselves. The review queue shows no per-draft caller
attribution and, after the retirement, is not expected to. The full reasoning is
in the review contract, under G.

### The tool catalog is the server's, not the agent's

`mcp.json` lists what the MCP server exposes for the souled runtime profile. It
is **not** a grant to the agent being viewed. What that agent may do is
`agentCapabilities` and its delegated scopes, stated separately by a different
authority, and the panel's heading and lede both say so. Presenting a server
registry as an agent's permissions would be the most misleading thing this
surface could do.

### CSP

The probes cross to `api.<domain>`. `connect-src` is widened by exactly one
origin on exactly this route — and the origin is not derived from the request,
it is the origin of the URL **lesser returned for this agent**. No published
endpoint means no widening at all. `script-src` and `style-src` are untouched;
no `unsafe-inline`, no `unsafe-eval`, no third-party origin.

## The swap seams

greater M6a will land vendored agent-roster and MCP-detail components. Face 6 is
built so that lands at **three component boundaries** and nothing else moves.

| Seam                                  | Owns (replaced with it)                                                                                           | Imported by                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `src/lib/agents/AgentRoster.svelte`   | `AgentCard`, `AgentDriversPanel`, `AgentRosterFilters`, `AgentSharedWithMePanel`, `AgentSharingPanel`, `MyAgents` | `routes/Agents.svelte`           |
| `src/lib/agents/AgentDetail.svelte`   | `AgentTrustDetail`, `AgentCapabilities`                                                                           | `routes/AgentDetailRoute.svelte` |
| `src/lib/agents/AgentMcpPanel.svelte` | `CopyBlock`, `Accordion`, and the probe rendering                                                                 | `AgentDetail.svelte`             |

The `Owns` column is `SEAMS` in `scripts/lib/agent-seams.mjs`, and it is
reproduced here rather than summarized: this table listed three of the roster's
components while the declaration named five, because the panels landed in M7,
M2.2 and M2.3 and the prose did not follow them. A seam table that is a partial
copy of the declaration is worse than none — it reads as the answer while the
gate is checking something wider.

`AgentTrustBadge` is **shared** on purpose: it is the one pill the roster card
and the detail header both show, and greater's `AgentStateBadge` replaces it on
both at once. It is the only component imported from more than one seam.

**Three, and this was two in an earlier draft.** The detail route imports
`AgentDetail.svelte`, so that file is a replaceable boundary whether or not it is
listed as one — and an undeclared boundary is the one nobody checks. It stays a
seam rather than being dissolved into the route, because the detail page has a
component-shaped middle: the identity header, trust and capabilities arranged
around a nested MCP panel. `AgentMcpPanel` sits INSIDE it and is still its own
seam, which is what lets the MCP detail be swapped without the page around it.

What does **not** change when the swap happens: the routes, the URL grammar
(`?type=`, `?q=`, `?verified=`, `?after=`), `filters.ts`, `contract.ts`,
`mcp.ts`, and the SSR loaders.

How that is checked, and where it used to not be. `tests/agents-mobile.test.mjs`
declares the table above as data and asserts three things against it: every
`.svelte` file in `src/lib/agents` is a seam, owned by exactly one seam, or
shared (a new file cannot quietly become a fourth boundary); no import INSIDE the
face crosses a seam — `AgentRoster` importing `CopyBlock` fails, and only the
declared `AgentDetail → AgentMcpPanel` nesting is allowed; and nothing outside
the directory imports anything behind a seam. The earlier check walked `src/`
with the agents directory skipped, so it could see a route reaching past a seam
but never two seams entangling each other, which is the failure that actually
makes a swap drag a second component with it.

**What counts as an import, and what happens to the forms that cannot be read.**
The check reads `import … from`, side-effect `import '…'`, `export … from`, and
dynamic `import('…')`, and it FOLLOWS the face's own modules — so a barrel
re-exporting `CopyBlock` does not turn a cross-seam dependency into a bare name
nothing objects to. `import … from` alone was all an earlier version read, which
left `await import('./CopyBlock.svelte')` and a re-export as two ways to take the
dependency and keep the check green. Everything it still cannot resolve — a
computed `import(expr)`, or a specifier into the directory naming nothing
declared — is a FINDING rather than a skip: "this could not be read" and "there
is nothing here" must not produce the same colour. Both bypasses and the
fail-closed behaviour are asserted against planted graphs in
`tests/agents-mobile.test.mjs`, in both directions.

**It reads code, not text, and it reads it with a parser.** Naming the forms is
not enough on its own. One review round compiled four legal files that took a
cross-seam dependency and returned nothing, because a comment sat where the
patterns expected whitespace — before the import, between `from` and the
specifier, and the same two on a re-export. The next round compiled two more past
the fix for those: a comment MERGING `import` into the binding beside it, since
stripping the comment joins the two tokens into `importX` and no pattern for
`import` matches it, and a markup comment carrying a fake `<script>` opener,
which steered the block-extracting pattern from inside the comment through the
real closing tag.

Three rounds of patching one scan is the evidence that the scan was the problem,
so there is no scan. `scripts/lib/module-imports.mjs` asks the SVELTE COMPILER
where a component's script is and the TYPESCRIPT COMPILER what an import is —
both are already in this repository's dependency tree, and both are already what
judges these files at build time. Comment placement is no longer a question the
check answers, in any position, because a comment is trivia to a tokenizer and a
`<script>` inside a comment is not a script block to a parser. A file either
parses, in which case its imports are its imports, or it does not, in which case
the check raises rather than reporting clean.

The computed-import form is the one a parser still cannot resolve: `const target
= '…'; import(target)` from outside the face was waved through when the walk
asked whether the expression contained the word `agents`. A computed import
cannot be asked to describe its own target, so it is no longer asked — an
`import()` this walk cannot resolve is a finding wherever it appears, inside the
face or outside it, whatever its text says. The exclusion that used to accompany
this rule is gone: a class member NAMED `import`, which vendored
greater-components has, is a declaration node rather than a call node, so no
hand-written rule has to keep them apart.

One thing the check does NOT rest on, because an earlier version of this section
implied it did: CON-5 is not a compensating reader for what this check might
miss. It reads with the same module now
(`gov-infra/verifiers/check-package-scripts.mjs`), which closed a comment-shaped
hole of its own, but its subject is the closure of the guarded package.json
scripts — gate code — and `src/` is declared outside that closure on purpose. A
cross-seam import in application source is invisible to it whatever it reads
with.

### The second check: the edges the build itself resolves

Reading source with a real parser closed the forms that had been found and did
not close the CLASS. Round 6 produced four more at once — a `.jsx` helper and a
`.tsx` helper, neither of which the walked file set included; a literal
`require()` in a `.cjs`, which is a call to a function named `require` and not an
import node to any syntax tree; and `import.meta.glob` in a `.ts`, which is a
member call on `import.meta` and not an import at all. Every one built a real
dependency the client build takes, and both probes stayed green.

The class is not comments, or queries, or suffixes. It is **every way Vite can
create a dependency** — a set defined by the bundler, extended by its plugins,
and not enumerable by anyone reading source. So the mechanism changed rather than
the list. `scripts/audit-seam-graph.mjs` (`pnpm run validate:seam-graph`, part of
`pnpm run validate` and therefore of `pnpm run build`) runs this repository's own
Vite configuration twice — the client pass and the server pass — and asserts the
seam rules against what the bundler resolved. Nothing is matched; the question is
not what the text says but what the build did.

**What that gate reads, stated as channels rather than as a guarantee.** An
earlier version of this section said the module graph covered every form the
build resolves, and round 7 disproved it: `url('./CopyBlock.svelte')` in a
component's `<style>` block crosses the `AgentDetail → AgentMcpPanel` seam, the
client build emits the component as an asset and writes its name into the
generated stylesheet, and the gate reported nothing. "The build resolved it" is
three channels, not one:

- **The module graph**, at `buildEnd` — every form that produces a module, which
  is where round 6's four live.
- **Asset references in module code**, also at `buildEnd` — `new URL('./X',
import.meta.url)` leaves Vite's own marker where an edge would be, and the
  emitted file names what it came from. A dependency that is not an import in any
  dialect is still an edge.
- **Asset references in stylesheets**, mid-pipeline — the same marker for a CSS
  `url()`, read in the one window where a CSS module's code still exists. By
  `buildEnd` that content has left the module graph for the stylesheet being
  assembled, which is why round 7's plant was invisible rather than merely
  unmatched.

A url() is an edge when the build **resolved it to a file**, whatever its
spelling: quoted, unquoted, a bare sibling name, through the `$lib` alias, with a
query, nested in `image-set()`, inside `@media` or `@supports`, an `@font-face`
source, or a root-absolute path naming a real file. A `data:` URL, a remote or
protocol-relative origin, and an absolute path with no file behind it resolve to
nothing and are not dependencies.

**The rule that holds the channels honest, because a list of channels is a list
and channels close.** Every module the build **loads** must have its code held by
one of the windows above — read at `buildEnd`, or read mid-pipeline for a
stylesheet whose content has already left the module graph by then. A module
neither window holds is a **finding** naming that module: this gate read nothing
for it, so what it references is unknown. A window that closes, for every module
or for one, costs the gate its green there.

Which modules the build loads is asked of the **build**, not of the module id, and
round 10 is why that clause is in the rule. A module the configuration
**externalizes** is resolved and then deliberately never opened, and the bundler
lists it under the id it resolved to — for an external file, an absolute path
spelled exactly like every loaded module's. Reading "the build went and got this
file" off that spelling made every module a consumer externalizes a module the gate
had failed to read, so a legitimate build went red for being configured. Rolldown's
`ModuleInfo` cannot be asked either — it has no `isExternal`, and its `code` is
`null` for _external or not yet available_, which are the two cases this rule tells
apart. So the gate watches the **load pipeline**: a plugin that reads nothing and
returns nothing records every id the build enters it for, and a module the build
never loaded is outside the rule because there is no code for it in any window to
have missed. That watch only widens what must be covered — a module the build holds
code for is loaded whether or not the watch saw it — so the day its position stops
seeing every load, the rule falls back to what it checked before rather than
quietly covering less.

The same fact is what keeps that exemption from becoming a hole, and **reached is
two facts rather than one**. **Resolved** is the pass having an edge to the module —
it is in that pass's graph, and that is the whole of it. **Loaded** is the pass having
gone and got it, which is the only way an edge _out_ of it is ever recorded. An
externalized module is resolved and not loaded, and the build stops at that boundary:
none of what that file depends on ever enters the build, so there is no edge out of it
here to have missed. It is counted — the gate's own output prints the two numbers side
by side and the difference between them is what it could not judge — and externalizing
a tracked file in the face lands in the containment rule below as a file that pass
cannot judge, instead of passing as a file it read.

**Reached is a fact about a pass**, and round 11 is what that cost when it was not
written down. The two passes recorded what they reached into one set, so a component
the client pass externalized was contained because the _server_ pass had loaded it —
and that the client pass never opened it, and so had nothing of its own to say about
what that component references, went unremarked.
The channels are asymmetric — a `new URL(…, import.meta.url)` is a client-pass edge,
an `import()` behind `import.meta.env.SSR` is a server-pass one, each invisible to
the other pass — so a union hands one pass the other's reading for a graph the other
never had. Both sets are kept **per pass**: a tracked face file a pass **resolves**
and never **loads** is that pass's finding, whatever the other pass did with the same
file, and a file no pass resolves at all is the older finding — the build never
reached it, so nothing about it is unexamined in either pass.

**And a file is not a module**, which is round 12 and the other half of the same
sentence. One file produces as many modules as there are ways to ask for it:
`CopyBlock.svelte` is the component, `CopyBlock.svelte?raw` is its text, and
`CopyBlock.svelte?svelte&type=style&lang.css` is its stylesheet — three modules the
bundler resolves and loads separately, and the text carries none of the component's
dependencies. Both reach sets were keyed by the **file**, so the seam that owns
`CopyBlock` importing its text put the file in `loaded`, and the client pass
externalizing the executable module beside it was therefore contained: the containment
rule had nothing to say about a module that pass never opened, and the gate printed
`771 / 771` and no findings over a component whose source carries a real cross-seam
dependency the text beside it does not. Reach is keyed by the **module** — the
request whole, query and fragment included — and the containment rule asks its
question of every module a tracked file produced. Edges stay keyed by the file,
which is the same distinction from the other side: an import of
`CopyBlock.svelte?raw` from outside the face is an import of the face component
whatever piece of it the importer asked for. **No variant shares another's fate**,
the style subrequest included — this build resolves and loads every one of them and
the stylesheet window reads each on its own, so a subrequest passes by being
examined rather than by inheriting an excuse, and a rule that let any module answer
for any other would be this finding rewritten.

Round 9 is why that is the rule rather than the one this section used to state.
The residual used to be the emitted-asset rule on its own: every asset the build
**emits** must be attributable to something that references it, one that is not
being a **finding** rather than a silence. That rule still runs and still catches a
channel closing from the other end — with the stylesheet window shut, round 7's
plant becomes an unaccounted-for asset instead of a pass. But attribution is by
emitted **file name**, and the build emits one file however many importers point at
it: two components with a `url()` at the same file get one asset, so a window that
closed for one of them stayed accounted for by the other's reference, and a real
cross-seam edge was green. A file name cannot tell two importers apart, and the
per-module rule above does not have to.

The single exception to the emitted-asset rule is a worker's own bundle, which is
generated code named by a marker Vite rewrites from a map of its own and
therefore can never be attributed; a worker is bundled by a separate build whose
plugin list the main pipeline is not in, and the gate reports that worker's
dependencies as **unknown** — a red gate in its own right. Supplying
`worker.plugins` from the gate was tried and rejected: it would replace whatever
`vite.config.ts` sets, and a gate that measures a build other than the real one
is worse than a gate with a stated boundary.

Two boundaries remain stated rather than closed. A file the build never loads has
no edges here at all — that is the source-reading probes' half, below. And a
reference the client pass turns into an emitted asset and the server pass does
not (`new URL(…)`, and a CSS `url()`) is a client-pass edge, so for a module only
the server pass loads, this gate records nothing about those references.

**Both checks stay, and neither is redundant.** They have different domains, and
the numbers say so: the source-reading probes walk 1246 tracked source **files**
under `src/`, and the build loads at least one module of 539 of them — of the 707
it never opens, 557 are vendored greater source nothing imports and 150 more are
source no entry reaches. Those are counts of files, and a file is not a module:
one file produces several (`X.svelte`, `X.svelte?raw`, its compiled stylesheet),
so the per-pass module counts the resolver gate prints are a different
measurement and a larger one. The source-reading probes read every tracked source
file and see one class of import form; the resolver gate reads every dependency
form and sees only the modules the build loads. A cross-seam import inside source
nothing loads is caught by the first and invisible to the second; a `.jsx` helper
wired into the live graph is caught by the second and invisible to the first.
Retiring either would open the half the other covers.

The resolver gate is itself proved to fail. `tests/seam-graph.test.mjs` plants
each of round 6's four forms as a real dependency through the gate's own build
overlay and asserts the gate names it, along with two forms invented for the
purpose: a wildcard `import.meta.glob('./[A-Z]*.svelte')`, which names no
component at all and resolves to ten cross-seam edges, and a `new URL(…)`
reference, which contains no import for any reader to read. Round 7's stylesheet
form is planted with the **bundle** as its witness rather than the gate's own
conclusion — the client build must emit the component and name it in the
generated CSS before the gate is asked anything — and ten url() spellings are
planted alongside four that resolve to nothing, each in a host of its own so a
form that stopped resolving loses its own line.

It is also proved not to fire, which a gate that can go red owes. Round 10's case
externalizes a planted module through the bundler's own mechanism and asserts the
gate says nothing about it, with the same plant **loaded** as the differential —
and, in the same run, a module the build did load and nothing read, still named.
Externalizing a tracked face component is a case of its own, and reports the
containment finding for each pass that did it rather than a green.

Round 11's two halves are planted the same way, one per pass: a client-pass-only
`new URL(…)` reference with the component externalized in the client pass, and a
server-pass-only `import()` behind `import.meta.env.SSR` with it externalized in the
server pass. Each asserts the unexternalized run as its differential, so a clean
externalized run is the masking rather than a plant that never built, and the control
is a module externalized in **both** passes carrying the same cross-seam reference —
still silent, because a file no pass opens is a file no pass takes an edge from.

Round 12's two directions are planted the same way, on a `?raw` import a consumer
would really write — the seam that owns `CopyBlock` asking for its text. The text
must not answer for the externalized component, and the component must not answer
for an externalized text, because a fix for one mask is where the reverse one gets
introduced. The plant is **asserted rather than assumed**: the case checks that the
`?raw` module really is one the client pass resolved and loaded before it concludes
anything from the silence around it.

### Why the composition is local today

greater v0.13.0 does export `shared/agent` `AgentIdentityCard` and
`AgentStateBadge`, which the roadmap names for this face. Read at that tag:

- `AgentStateBadge` is genuinely generic — a label, a tone, an emphasis — and
  `AgentTrustBadge` is modelled directly on it, so that swap is close to a
  rename.
- `AgentIdentityCard` is **not** a fit. Its `AgentIdentityCardData` is the
  soul-genesis workflow's shape (`steward`, `currentPhase`, `currentState` drawn
  from `AgentWorkflowPhase`/`AgentWorkflowState`), not a federated agent's; it
  renders its own `<h2>` and an "Agent identity" eyebrow per card, which is the
  wrong heading structure for a grid; and it paints on literal `white` with a
  light-theme shadow, against contentus's dark-first brand.
- `shared/agent` is not vendored into contentus. Reaching it would pull nine
  soul-genesis components (`SoulRequestCard`, `SoulLifecycleRail`,
  `GraduationSummaryCard`, …) to use one pill, and `greater add` re-emits the
  whole vendored tree at the `components.json` ref rather than adding to it.

This is what the roadmap prescribes for M6 — "until vendored, v1 composes the
roster from `shell` (Panel, StatCard, PageFrame) + primitives" — and `Panel`,
`StatCard` and `PageFrame` are exactly the vendored shell used here.

## Mobile

Single column below 960px. MCP sections are native `<details>` accordions:
rendered **open** by the server and closed on mount only on a phone viewport, so
script makes a phone tidier and its absence never hides the contract. Copy
blocks are always selectable text with the copy button layered on top and
rendered only after mount — `navigator.clipboard` needs a secure context and a
permission that can be refused, and a failed copy says so rather than silently
doing nothing.

No config snippet embeds a token. One is minted through the OAuth flow the
discovery documents describe; a snippet that looked ready to run would advertise
a credential this page never had.
