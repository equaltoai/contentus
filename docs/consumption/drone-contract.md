# Drone creation contract consumption

Contentus consumes lesser's agent GraphQL surface for the `/drones` face. It
does not define a parallel drone model: a drone is the pre-soul lifecycle state
of an `Agent`, and lesser remains authoritative for ownership and workflow
state.

## Owned roster

- `myAgents` is the only roster source. Contentus reuses the Face 6 agent
  projection rather than guessing ownership from public actor data.
- `droneWorkflow(username)` is an optional per-agent enrichment. Its
  `currentPhase`, `currentState`, and `identitySemantics` values are displayed
  verbatim. Failure of this optional read does not erase an agent returned by
  `myAgents`; the card instead reports that workflow status is unavailable.
- The route requires the broad OAuth `write` scope. A session without that
  exact scope must reauthorize through lesser `auth-ui`; similarly named
  granular scopes are not treated as equivalents.
- Both operations are private and run only in the browser with the token held
  in `sessionStorage`. The `/drones` server render is a signed-out shell, issues
  no private GraphQL reads, uses `Cache-Control: no-store`, and is not indexed.

No article or draft content crosses this face, so lesser's renderer authority
is unaffected.

## Creation and policy

- `/drones/new` sends one `delegateToAgent(input)` mutation. The visible form
  owns username, display name, bio, the six-value `AgentType` enum, and the
  delegated scope selection. Contentus supplies `1.0.0` for both required
  version fields because version is not a product-design field in this face.
- Validation mirrors lesser's current byte limits and username expression:
  `^[a-zA-Z0-9_-]{1,30}$`, 30 UTF-8 bytes for display name, 500 UTF-8 bytes
  for bio, and at least one scope. Lesser remains authoritative and can reject
  an otherwise locally valid request.
- `adminAgentPolicy { allowAgents allowAgentRegistration }` is a best-effort
  preflight. Lesser restricts that field to administrators, so a refusal means
  policy **unknown**, not enabled. For ordinary write-scoped callers, the
  mutation's explicit registration-disabled error is the authoritative signal;
  Contentus then replaces the form with the policy-disabled state.
- The returned access and refresh tokens are held only in the mounted creation
  component's memory. They are never written to Web Storage, route state,
  hydration data, logs, or another request. Dismiss, navigation, sign-out, and
  session change make them unrecoverable from Contentus. Each token remains
  selectable when Clipboard API access is unavailable.

## Soul-promotion boundary

Contentus does not implement `drone → graduating → souled`. Roster cards and
the post-creation credential panel link to simulacrum's same-origin
`/identity/{username}` surface. The helper intentionally does not add the `/l`
Contentus base path and encodes the lesser-provided username; it never invents
an instance hostname or duplicates the identity workflow.

## Replacement seams

`DroneRoster.svelte` owns the roster card; `DroneCreationFlow.svelte` owns the
form, policy-disabled panel, and credential reveal. Routes import only those two
seams. `scripts/lib/drone-seams.mjs` is the single declaration consumed by the
build-resolved seam-graph gate, so a future greater-components replacement can
swap either workspace without leaving a cross-seam component dependency behind.
