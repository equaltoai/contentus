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
