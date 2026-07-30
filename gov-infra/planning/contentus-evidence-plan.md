# contentus Evidence Plan (Rubric v1.0.0)

`bash gov-infra/verifiers/gov-verify-rubric.sh` is the single entrypoint. It writes a
`gov_rubric_report.v1` document to `gov-infra/evidence/gov-rubric-report.json` and one
log per control beside it. The pull-request CI hook runs that same entrypoint and uploads
the directory as an artifact. There is no second rubric and no alternate refresh path.

| Controls               | Refresh command                      | Evidence                                                  |
| ---------------------- | ------------------------------------ | --------------------------------------------------------- |
| QUA-\*, CON-\*, COM-\* | verifier                             | `gov-infra/evidence/*-output.log`                         |
| SEC-2                  | verifier / `check_disclosed_audit`   | `gov-infra/evidence/SEC-2-output.log`                     |
| SEC-3                  | verifier / `check_supply_chain`      | `gov-infra/evidence/SEC-3-output.log`                     |
| SEC-5, SEC-6           | verifier                             | `gov-infra/evidence/SEC-5-output.log`, `SEC-6-output.log` |
| SEC-7                  | verifier / `check_greater_integrity` | `gov-infra/evidence/SEC-7-output.log`                     |
| CMP-\*, DOC-\*         | verifier                             | planning docs and `DOC-5-parity.log`                      |
| MAI-4                  | verifier / `check_ci_hook`           | `gov-infra/evidence/MAI-4-output.log`                     |

## Two pins, two purposes

`contentus-disclosed-upstream-findings.json` records upstream state this repository
cannot fix and does not own — what SEC-2 and SEC-7 assert has not changed. It is
schema-validated before either gate reads it, because a mistyped key silently turns an
assertion into a loop over nothing while the control still reports PASS.

`contentus-pinned-repo-contract.json` records this repository's own gate-facing
artifacts — guarded `package.json` scripts, the SEC-6 probe inventory and its minimums,
the install manifest's allowed build invocation, the greater release and vendoring
commit, and the one allowlisted workflow write permission. It exists because those
artifacts are editable in the pull request being gated (THR-9). Changing a value in
either file is a governance change and travels with its reason.

## The bootstrap head carries two reports

`gov-rubric-report.json` is the report for this ref, and on the gov-infra spine branch
it is red: `staging` has no `package.json`, no lockfile, no `src/`, and no build, so
every toolchain control fails structurally. That is the honest result for this ref and
it is committed as such.

`composite-m1-spine-gov-rubric-report.json` is the same verifiers run against the M1
application tree — the tree these controls were written for. It is the green evidence
for the spine, and it is a snapshot, not a refresh path: nothing in this repository
regenerates it, and it is not evidence for this ref. Both are named in the pull request.
Once M1 merges to `staging`, the composite and the ref are the same tree and the second
report retires with the bootstrap exception in `AGENTS.md`.

## Freshness

Evidence is regenerated, never edited. The verifier deletes the report and every
`*-output.log` before it runs, so a stale log cannot survive a run and no partial refresh
is possible. Committed evidence is a snapshot of one ref; it is re-run at every head that
is proposed for merge.

## Statuses and what they mean

- **PASS** — the command ran here and succeeded. Never recorded without running.
- **FAIL** — the command ran and failed. The repair is to fix the control, never to
  relax it.
- **BLOCKED** — the command could not run (missing tooling, unconfigured command). The
  overall report is BLOCKED, and BLOCKED is not green: the verifier exits non-zero.

A report whose `summary.status` is anything other than `PASS` does not satisfy
`run-rubric-gate`, and the steward does not push on it.

## What the evidence does not establish

Per the governance profile's `does_not_prove` list, and repeated here because reports get
read out of context: a green rubric is not proof of security, not proof of
deployability, not install verification against any lesser instance, and not deploy,
merge, or signing authority. Signing is retired for this lifecycle surface. Namespace MCP
guidance does not replace this repo-local CI.
