# contentus Governance Roadmap (v1.0.0)

## M0 — Materialize CI-core governance

- Stand up canonical `gov-infra`, the deterministic verifier, and the pull-request CI
  evidence hook for `staging` integration.
- Do not weaken validation, supply-chain, renderer-authority, or web-integrity gates to
  reach a first green.

## M1 — Reach a real green at an application head

`staging` currently carries the repository's genesis documents only; the application, its
toolchain, and its tests live on the unmerged M1 branch. Every command-based control is
therefore FAIL at the gov-infra head itself, and the rubric only becomes meaningful once
the application tree and this spine are on the same ref.

- Land this spine on `staging`, then rebase the M1 branch onto it so the M1 merge gate
  reads a real `gov_rubric_report.v1` at the head under decision.
- Do not add "skip when the toolchain is absent" conditions to reach green on a bare
  tree. A gate that skips itself when its subject is missing is a gate that a deletion
  can satisfy.

The gates were nevertheless verified against a real application tree before this spine
was proposed, so that "FAIL at this ref" is known to mean "no subject here" rather than
"never exercised". Applying this exact `gov-infra/` and `.github/` to a detached checkout
of the M1 head `c0e39ce`, after a clean `pnpm install --frozen-lockfile` and the pinned
CLI install, produced `PASS (31 pass, 0 fail, 0 blocked)`. That run is recorded in the
pull request rather than committed here, because evidence belongs to the ref it was
produced at and this ref is not that one.

## M2 — Retire the disclosed upstream findings

- Route the `ws` advisory (`GHSA-96hv-2xvq-fx4p`, reached through the pinned adapters
  tarball) to the greater-components steward through Factory, and record the issue number
  in `contentus-disclosed-upstream-findings.json` once it exists.
- Track `equaltoai/greater-components#917` until the blog face stops requiring the unused
  Markdown chain.
- Each retirement is a deletion from the pin file, which makes the corresponding control
  fail until the entry is removed. That forcing function is intentional.

## M3 — Maintain evidence

- Run the verifier at each PR head; CI uploads `gov-infra/evidence/` as the fresh
  `gov_rubric_report.v1` artifact.
- Update the controls matrix, threat model, and evidence plan whenever a deterministic
  gate changes.

## Known toolchain constraint — the `greater` CLI

The CLI is not published to the npm registry; it ships as a GitHub release asset. CI
installs the pinned `greater-v0.11.9` asset into `gov-infra/.tools/`, which keeps SEC-7
runnable and pinned to the same release the vendored tree came from. If that asset ever
moves, SEC-7 reports BLOCKED rather than passing — and the durable fix is upstream
publication of the CLI, not a repo-local reimplementation of `greater doctor`.

## Operator-owned repository settings

- Branch protection for `main` and `staging`, including required reviews and required
  status checks, is an operator-owned GitHub setting outside this pull request. A
  repository-level control can declare ownership in CODEOWNERS; it cannot configure or
  verify branch-protection policy from a pull request.
- Merge authority is the operator's. This spine opens PRs and reports evidence; it never
  merges, force-pushes, deletes branches, deploys, signs, or mutates cloud state.

## Namespace profile scope gap

The namespace governance profile resolves `software_repo_steward` to
`software_repo_gov_infra`, which is why this profile applies here. Its
`applies_to_repositories` list (`lesser`, `lesser-host`, `lesser-body`,
`greater-components`, `simulacrum`, `emdash`, `lesser-soul`) does not yet name
`contentus`. Adding it is an operator-level namespace edit, not a repo-local change, and
is recorded here rather than worked around.
