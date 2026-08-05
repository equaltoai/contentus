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
