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
so there is no scan. `tests/helpers/module-imports.mjs` asks the SVELTE COMPILER
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
miss. CON-5's own import reader is raw-text regex
(`gov-infra/verifiers/check-package-scripts.mjs`), and a comment moved inside an
import statement makes it miss the edge as well. It is a real gate against
unresolvable relative specifiers in gate files — which is why the planted
fixtures address the face in a form that resolves — and it is nothing more than
that here.

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
not (`new URL(…)`, and a CSS `url()`) is a client-pass edge, so a module only the
server pass loads takes those dependencies unrecorded.

**Both checks stay, and neither is redundant.** They have different domains, and
the numbers say so: the build loads 540 of this repository's 1246 tracked
modules, because most of the vendored greater tree is source nothing imports. The
source-reading probes read every tracked file and see one class of import form;
the resolver gate reads every dependency form and sees only the modules the build
loads. A cross-seam import inside dead vendored source is caught by the first and
invisible to the second; a `.jsx` helper wired into the live graph is caught by
the second and invisible to the first. Retiring either would open the half the
other covers.

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
