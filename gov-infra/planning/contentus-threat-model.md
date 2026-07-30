# contentus Threat Model (custom — v1.0.0)

## Scope

- **System:** the FaceTheory + greater-components **lesser CMS client** — a pnpm/Vite
  two-pass (client + SSR) build installed into a lesser instance only through
  `lesser client install`. It serves the public article reading surface and, once the
  authoring milestones land, the authenticated draft → preview → review → publish
  workflow over lesser's GraphQL CMS surface.
- **In-scope data:** server-rendered article HTML received from lesser, route and head
  output produced by the SSR handler, the vendored greater-components tree, the pinned
  dependency graph, the install manifest, and CI runtime configuration.
- **Out of scope:** lesser's CMS contract, its renderer/sanitizer, its persistence and
  federation, `auth-ui` itself, greater-components source, FaceTheory internals,
  lesser-host provisioning, key custody, and any cloud or on-chain state. Contentus owns
  none of these and routes defects to their stewards.
- **Environments:** local development, `staging` pull-request CI, operator-run installs
  against the trenchcoat dev instance, and operator-owned promotion to `main`.
- **Third parties:** GitHub Actions, the pnpm registry, greater-components and FaceTheory
  release tarballs, and the `greater` CLI.
- **Assurance target:** audit-ready repository controls.

## Assets and trust boundaries

- **Assets:** the renderer-authority invariant, the SSR trust boundary between the edge
  and the handler, a reproducible installable build, the vendored-source pin, and PR
  evidence.
- **Trust boundaries:** contributor changes; the lesser instance's GraphQL responses
  (remote, untrusted-until-typed); the HTTP request as it reaches the SSR handler
  (`Host` and forwarded headers are attacker-controllable unless the edge verified
  them); package release tarballs; GitHub Actions.
- **Entry points:** pull requests to `staging`. No workflow runs on direct pushes.

| Threat ID | Title                         | What can go wrong                                                                                                                                                  | Primary controls    | Verification                                       |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------- |
| THR-1     | Supply-chain compromise       | A mutable Action, a lifecycle hook, or an unlocked dependency executes in CI.                                                                                      | SEC-3, COM-2        | `check_supply_chain`                               |
| THR-2     | Client regression             | SSR routes, types, Svelte components, or the two-pass build regress.                                                                                               | QUA-1, QUA-2, CON-2 | build, tests, type checks                          |
| THR-3     | Web-integrity regression      | Built output introduces inline scripts, styles, or event handlers, or a third-party script origin, breaking the strict CSP the FaceTheory host enforces.           | SEC-4               | built-output CSP audit                             |
| THR-4     | Governance drift              | The deterministic rubric or the pull-request CI hook disappears or goes stale.                                                                                     | MAI-4, DOC-5        | CI-hook and threat/control parity checks           |
| THR-5     | Renderer-authority violation  | A Markdown or HTML rendering path, a client-side excerpt/TOC generator, or a raw-draft-source display appears in the client, creating a second canonical renderer. | SEC-5               | `pnpm run validate:renderer-authority`             |
| THR-6     | SSR trust-boundary regression | The handler resolves its origin from an unverified `Host`, leaks withheld article source, or serves 200 for a CMS object that does not exist.                      | SEC-6               | built-handler SSR probes                           |
| THR-7     | Vendored-source drift         | A vendored greater-components file is hand-edited, an orphan appears under the vendored root, or the CLI-copy and tarball channels drift out of lockstep.          | SEC-7, CON-4        | `greater doctor`, pin-lockstep check               |
| THR-8     | Disclosed-finding drift       | A known, unfixed upstream finding silently changes shape, or a new finding hides behind an old one.                                                                | SEC-2, SEC-7        | exact-set assertion against the pinned disclosures |

## Accepted coverage and semantic limits

These are the limits of what the gates above actually prove. They are recorded so that a
green report is read for what it is.

- **Renderer-authority audit scope.** `scripts/audit-renderer-authority.mjs` enforces two
  halves: no Markdown-rendering package enters the dependency graph, and the single
  body-resolution gate withholds anything that is not server-rendered HTML. It is a
  dependency-and-call-site audit, not a proof that no future component could render.
  Its strength depends on the audit keeping pace with new rendering surfaces.
- **CSP audit scope.** The audit fails on inline execution surfaces and reports external
  origins in built output across the seven audited routes. It is not a CSP header
  implementation and holds no origin allowlist; the header is enforced by the FaceTheory
  host, not by this repository.
- **SSR probe coverage.** `tests/ssr-probe.test.mjs` drives `build/server/handler.mjs`
  with stubbed GraphQL responses. It proves the built artifact's behaviour on the loaded
  path for the fixtures it supplies. It is not a live-instance test; install verification
  against the dev instance remains a separate, operator-run step.
- **Build-before-test ordering.** The SSR probes and the uncompiled-rune guard read
  `build/`. The rune guard walks an empty set when `build/` is absent and would pass
  vacuously, so the rubric runs the build (QUA-1) before the suite (QUA-2) and asserts
  the artifacts exist (COM-1). Running `pnpm test` alone against a clean checkout is not
  evidence.
- **`greater doctor` availability.** The `greater` CLI is not published to the npm
  registry. CI installs the pinned `greater-v0.11.9` release tarball into
  `gov-infra/.tools/`. If neither that install nor a PATH `greater` resolves, SEC-7
  reports BLOCKED — never PASS.
- **Disclosed upstream findings.** SEC-2 and SEC-7 assert an exact finding set, not an
  empty one. Two findings are currently disclosed and unfixed upstream: a high-severity
  `ws` advisory reached through the pinned adapters tarball, and the blog face's
  unused-Markdown-chain dependency requirement. Neither gate proves the absence of the
  disclosed problem; each proves the problem has not changed and nothing new hides behind
  it. See `contentus-disclosed-upstream-findings.json`.
- **CodeQL.** The PR-only posture intentionally leaves no default-branch analysis, and
  fork PRs cannot upload `security-events`.
- **DCO.** The check proves a `Signed-off-by` trailer exists; it does not bind that
  trailer's identity to the commit author.
- **Promotion PR checks.** `staging` → `main` promotion PRs run only `main-guard` and
  DCO by design. The broader gates run on feature → `staging`. Branch protection on both
  branches is an operator-owned GitHub setting outside this repository.
- **Workflow structural sentinel limit.** MAI-4 verifies required sentinel tokens in
  line-oriented `run:`/`uses:` surfaces and rejects workflows whose recognized jobs are
  all `if: false`. It does not interpret arbitrary GitHub expression semantics or
  composite actions; branch protection and CI execution remain separate enforcement.
- **Install verification is not in this rubric.** A green report says the repository's
  gates passed at a ref. It says nothing about whether the app installs into, or renders
  correctly on, any lesser instance. That evidence comes from
  `install-contentus-instance` against a named instance at a named build.
