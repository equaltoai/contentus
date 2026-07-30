# contentus Controls Matrix (v1.0.0)

Every control below is a runnable command or a deterministic artifact check invoked by
`bash gov-infra/verifiers/gov-verify-rubric.sh`. There are no manual-checklist controls.

| Control ID | Threat IDs                                             | Control                                                                                                                                                                                                                 | Deterministic evidence |
| ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| QUA-1      | THR-2                                                  | Run the full two-pass build: typecheck, svelte-check, client build, SSR build, brand/manifest assets, and both audits. Runs before the suite because the probes read `build/`.                                          | `QUA-1-output.log`     |
| QUA-2      | THR-2                                                  | Run the committed Node test suite against the built artifacts.                                                                                                                                                          | `QUA-2-output.log`     |
| QUA-3      | THR-2                                                  | Run svelte-check at error threshold.                                                                                                                                                                                    | `QUA-3-output.log`     |
| CON-1      | THR-2                                                  | Run Prettier in check mode across the repository.                                                                                                                                                                       | `CON-1-output.log`     |
| CON-2      | THR-2                                                  | Run the TypeScript compiler with no emit.                                                                                                                                                                               | `CON-2-output.log`     |
| CON-3      | THR-2                                                  | Validate `facetheory.lesser.json` against the keys `lesser client install` reads: schema version, app name, build command, server dir/entry/export, and asset dir.                                                      | `CON-3-output.log`     |
| CON-4      | THR-7                                                  | Assert the two greater channels stay in lockstep: every `@equaltoai/greater-components-*` tarball pin resolves to the same release tag, and `components.json` records `installMode: vendored` with a pinned `ref`.      | `CON-4-output.log`     |
| COM-1      | THR-2                                                  | Assert the build produced the artifacts the install manifest points at: an SSR handler exporting `handler`, and a non-empty client asset directory.                                                                     | `COM-1-output.log`     |
| COM-2      | THR-1                                                  | Require the declared Node 24 engine and a pnpm lockfile at version 9.                                                                                                                                                   | `COM-2-output.log`     |
| COM-3      | THR-4                                                  | Require the steward-facing surfaces that carry the branch/profile contract and the install runbook.                                                                                                                     | `COM-3-output.log`     |
| COM-4      | THR-4                                                  | Require the pull-request CI workflow set.                                                                                                                                                                               | `COM-4-output.log`     |
| SEC-1      | THR-1                                                  | Require a CodeQL workflow whose action is pinned by 40-hex commit SHA.                                                                                                                                                  | `SEC-1-output.log`     |
| SEC-2      | THR-1, THR-8                                           | Run the production audit at high severity and assert the resulting advisory set is exactly the pinned disclosed set — no new advisory, no changed path, no silent disappearance.                                        | `SEC-2-output.log`     |
| SEC-3      | THR-1                                                  | Pin GitHub Actions by immutable commit, require `pnpm-lock.yaml`, install with lifecycle scripts disabled, and scan installed lifecycle hooks.                                                                          | `SEC-3-output.log`     |
| SEC-4      | THR-3                                                  | Fail if built output contains inline script, style, or event-handler execution surfaces; report external origins across the audited routes for reviewer visibility.                                                     | `SEC-4-output.log`     |
| SEC-5      | THR-5                                                  | Run the renderer-authority audit: no Markdown-rendering package in the dependency graph, and the body-resolution gate withholds anything that is not server-rendered HTML.                                              | `SEC-5-output.log`     |
| SEC-6      | THR-6                                                  | Drive the built SSR handler through the trust-boundary probes: origin resolved only from the edge-verified host, withheld source never leaving the server, and 404 for CMS objects that do not exist.                   | `SEC-6-output.log`     |
| SEC-7      | THR-7, THR-8                                           | Run `greater doctor` against the pinned CLI: assert component-file and orphan integrity PASS, and that the non-passing set is exactly the pinned disclosed set. BLOCKED — never PASS — when the CLI cannot be resolved. | `SEC-7-output.log`     |
| CMP-1      | THR-4                                                  | Require this controls matrix.                                                                                                                                                                                           | planning doc           |
| CMP-2      | THR-4                                                  | Require the evidence plan.                                                                                                                                                                                              | planning doc           |
| CMP-3      | THR-4                                                  | Require the threat model.                                                                                                                                                                                               | planning doc           |
| MAI-1      | THR-4                                                  | Require a non-empty verifier entrypoint.                                                                                                                                                                                | `MAI-1-output.log`     |
| MAI-2      | THR-4                                                  | Require the governance roadmap.                                                                                                                                                                                         | `MAI-2-output.log`     |
| MAI-3      | THR-4                                                  | Require exactly one verifier entrypoint — no second, divergent rubric.                                                                                                                                                  | `MAI-3-output.log`     |
| MAI-4      | THR-4                                                  | Require a pull-request invocation of the deterministic rubric, the required-workflow sentinels, and pull-request-only triggers.                                                                                         | `MAI-4-output.log`     |
| DOC-1      | THR-4                                                  | Require the threat model.                                                                                                                                                                                               | planning doc           |
| DOC-2      | THR-4                                                  | Require the evidence plan.                                                                                                                                                                                              | planning doc           |
| DOC-3      | THR-4                                                  | Require the rubric document.                                                                                                                                                                                            | planning doc           |
| DOC-4      | THR-4                                                  | Require a non-empty README and reject unrendered template placeholder tokens left behind in the planning set.                                                                                                           | `DOC-4-output.log`     |
| DOC-5      | THR-1, THR-2, THR-3, THR-4, THR-5, THR-6, THR-7, THR-8 | Require threat/control parity: every threat ID in the threat model is mapped here.                                                                                                                                      | `DOC-5-parity.log`     |

## Accepted coverage and semantic limits

The limits below are the same ones recorded in the threat model; they are repeated here
so that this matrix is not read as a stronger claim than the gates support.

- **SEC-2 and SEC-7 pin disclosed upstream state.** Both gates assert an exact finding
  set, not an empty one. A high-severity `ws` advisory (reached through the pinned
  `@equaltoai/greater-components-adapters` tarball) and the blog face's unused-Markdown-
  chain dependency requirement (`equaltoai/greater-components#917`) are known, unfixed,
  and owned upstream. A PASS on either control means "unchanged", not "clean". The full
  disclosure, including why neither is fixable from the consumer side and what retires
  each, lives in `contentus-disclosed-upstream-findings.json`.
- **SEC-7 depends on a CLI that is not on the registry.** The `greater` CLI is
  distributed as a GitHub release asset. CI installs the `greater-v0.11.9` asset into
  `gov-infra/.tools/`. Where it cannot be resolved, SEC-7 is BLOCKED and the report is
  BLOCKED with it.
- **SEC-4 is not a CSP header.** It audits built output for inline execution surfaces and
  prints external origins. The enforced header is the FaceTheory host's.
- **SEC-6 uses stubbed GraphQL responses.** It proves the built handler's behaviour on
  the fixtures supplied, not the behaviour of any live instance.
- **QUA-2 is only meaningful after QUA-1.** The uncompiled-rune guard walks `build/`; on
  a clean checkout with no build it walks an empty set. The ordering in the verifier is
  load-bearing, and COM-1 asserts the artifacts actually exist.
- **CodeQL** is PR-only: no default-branch analysis, and fork PRs cannot upload
  `security-events`.
- **DCO** verifies trailer presence per commit, not that the signer is the commit author.
- **Promotion PR checks:** `staging` → `main` PRs run only `main-guard` and DCO. That both
  protected branches require their intended checks rests on operator-confirmed,
  out-of-repository GitHub branch protection.
- **Nothing here is install evidence.** A green report is gates-passed-at-a-ref. Whether
  contentus installs into and renders on a lesser instance is separate, operator-run
  verification.
