# contentus 10-of-10 Rubric (v1.0.0)

The deterministic entrypoint is `bash gov-infra/verifiers/gov-verify-rubric.sh`. Every
check fails closed. Missing tooling is BLOCKED and does not yield a passing report.

| Category        | Controls                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality         | Two-pass build, the Node suite driven against built artifacts, and Svelte checks                                                                                                   |
| Consistency     | Prettier, TypeScript, install-manifest validation, greater channel pin lockstep, and guarded-script binding                                                                        |
| Completeness    | Build artifacts, Node/pnpm pins, steward surfaces, the CI workflow set, and a script-free frozen install                                                                           |
| Security        | CodeQL pinning, pinned-disclosure full-graph audit, supply-chain and workflow-policy scan, CSP audit, renderer authority, SSR trust-boundary probes, and vendored-source integrity |
| Compliance      | Controls matrix, evidence plan, and threat model                                                                                                                                   |
| Maintainability | Entrypoint, roadmap, singleton verifier, and PR CI hook                                                                                                                            |
| Docs            | Planning artifacts and threat/control parity                                                                                                                                       |

## Ordering is load-bearing

QUA-1 (`pnpm run build`) runs before QUA-2 (`pnpm test`), SEC-4, and SEC-6. The SSR
probes drive `build/server/handler.mjs`, and the uncompiled-rune guard walks `build/` —
on a clean checkout with no build it walks an empty set and passes vacuously. COM-1
asserts the artifacts exist so that a vacuous pass cannot masquerade as coverage.

## An exit code is not evidence when the repository owns the command

Most controls here are `pnpm run <name>`, and `package.json` is editable in the same
pull request the rubric is judging. A script rewritten to `true` exits 0; so does an
emptied test file, and so does an install manifest retargeted at something else. Those
are the cheapest ways to make this report green without any of its properties holding,
so the artifacts the rubric trusts are pinned in
`contentus-pinned-repo-contract.json` and asserted against: guarded scripts and their
`pnpm run` delegates (CON-5), the SEC-6 probe inventory and its per-file TAP test-point
minimums, the install manifest's build invocation and path containment (CON-3), the
built handler's declared export (COM-1), and the greater release/vendoring commit
(CON-4, SEC-7).

This is THR-9, and its limit is written into the threat model: an author who edits both
the artifact and the pin still moves the gate. The pin makes that edit land in
`gov-infra/planning`, in the same diff, as the review's subject. Cross-client
adversarial review is the other half of the control, not an optional supplement to it.

## Two controls assert disclosed state, not clean state

SEC-2 and SEC-7 each run their gate in full and assert the finding set is exactly the set
pinned in `contentus-disclosed-upstream-findings.json`. A PASS means the known upstream
findings are unchanged and nothing new is hiding behind them — not that the gate is
clean. Both disclosures are owned upstream, carry a sunset, and are named in every
report. This is a pinned exception with an owner, not an exclude.
