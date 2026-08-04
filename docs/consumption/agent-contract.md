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

**2. Redaction is indistinguishable from data.** `redactGraphAgentPrivateFields`
blanks `agentOwner` to null, `delegatedScopes` to `[]`, and the soul fields to
`UNBOUND` for anyone who is not the agent's owner or an admin. Rendering those
would tell every anonymous visitor that every agent has no owner and no scopes.
The view model omits them unless the read was authorized to see them, and
`viewerIsOwner` is derived from what lesser **answered**, never from whether a
token was sent.

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

| Seam                                  | Owns (replaced with it)                           | Imported by                      |
| ------------------------------------- | ------------------------------------------------- | -------------------------------- |
| `src/lib/agents/AgentRoster.svelte`   | `AgentCard`, `AgentRosterFilters`, `MyAgents`     | `routes/Agents.svelte`           |
| `src/lib/agents/AgentDetail.svelte`   | `AgentTrustDetail`, `AgentCapabilities`           | `routes/AgentDetailRoute.svelte` |
| `src/lib/agents/AgentMcpPanel.svelte` | `CopyBlock`, `Accordion`, and the probe rendering | `AgentDetail.svelte`             |

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

**It reads code, not text.** Naming the forms is not enough on its own: a review
round compiled four legal files that took a cross-seam dependency and returned
nothing, because a comment sat where the patterns expected whitespace — before
the import, between `from` and the specifier, and the same two on a re-export.
The scan now runs over the source the module system executes, with the comments
of that source's own language removed (`tests/helpers/module-imports.mjs` over
`scripts/lib/strip-comments.mjs`), so a comment can say anything and a comment
can hide nothing. In a component that means the `<script>` blocks, because they
are what Svelte runs.

The same round's fourth form was `const target = '…'; import(target)` from
outside the face, which the walk had waved through because the expression did
not contain the word `agents`. A computed import cannot be asked to describe
its own target, so it is no longer asked: an `import()` this walk cannot resolve
is a finding wherever it appears, inside the face or outside it, whatever its
text says. The single exclusion is syntactic — a class member NAMED `import`,
which vendored greater-components has, is a declaration and not a call.

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
