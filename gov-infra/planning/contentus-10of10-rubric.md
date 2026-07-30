# contentus 10-of-10 Rubric (v1.0.0)

The deterministic entrypoint is `bash gov-infra/verifiers/gov-verify-rubric.sh`. Every
check fails closed. Missing tooling is BLOCKED and does not yield a passing report.

| Category        | Controls                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality         | Two-pass build, the Node suite driven against built artifacts, and Svelte checks                                                                               |
| Consistency     | Prettier, TypeScript, install-manifest validation, and greater channel pin lockstep                                                                            |
| Completeness    | Build artifacts, Node/pnpm pins, steward surfaces, and the CI workflow set                                                                                     |
| Security        | CodeQL pinning, pinned-disclosure production audit, supply-chain scan, CSP audit, renderer authority, SSR trust-boundary probes, and vendored-source integrity |
| Compliance      | Controls matrix, evidence plan, and threat model                                                                                                               |
| Maintainability | Entrypoint, roadmap, singleton verifier, and PR CI hook                                                                                                        |
| Docs            | Planning artifacts and threat/control parity                                                                                                                   |

## Ordering is load-bearing

QUA-1 (`pnpm run build`) runs before QUA-2 (`pnpm test`), SEC-4, and SEC-6. The SSR
probes drive `build/server/handler.mjs`, and the uncompiled-rune guard walks `build/` —
on a clean checkout with no build it walks an empty set and passes vacuously. COM-1
asserts the artifacts exist so that a vacuous pass cannot masquerade as coverage.

## Two controls assert disclosed state, not clean state

SEC-2 and SEC-7 each run their gate in full and assert the finding set is exactly the set
pinned in `contentus-disclosed-upstream-findings.json`. A PASS means the known upstream
findings are unchanged and nothing new is hiding behind them — not that the gate is
clean. Both disclosures are owned upstream, carry a sunset, and are named in every
report. This is a pinned exception with an owner, not an exclude.
