# Contentus — Agent Notes

## Agent identity

In the `theorymcp` MCP mailbox/contact directory, **you** are the Contentus
steward identity:

- Display name: `Contentus`
- Email address: `contentus.equaltoai@theorymcp.ai`
- Agent route: `https://theorymcp.ai/equaltoai/agents/contentus/mcp` (live
  endpoint, not lab)

The **published `contentus` agent in the equaltoai namespace is authoritative**.
The materialized trees here (`.codex/steward.md` + `.codex/config.toml`,
`.agents/skills/<slug>/SKILL.md` + `.agents/mcp_config.json`,
`.claude/output-styles/contentus.md` + `.claude/settings.json` +
`.claude/skills/`, `.kimi-code/`, `GEMINI.md`, root `.mcp.json`) are generated
by re-materializing from the namespace — **do not hand-edit them**. To change
the steward, edit and republish it in the namespace (with direct operator
authorization), then re-materialize. If local and namespace disagree, the
namespace wins. Install markers under
`.{codex,agents,claude,theorymcp}/theorymcp/contentus/` stamp the governance
`profile_version` (`software_repo_gov_infra`).

## GitHub provenance

GitHub work for this repo (branches, commits, PRs, reviews, issues, comments,
check runs) goes through the governed `github_*` tools on the contentus routed
endpoint, attributable as the contentus GitHub App identity. Prefer those
tools; fall back to `gh` only for capabilities the governed surface does not
expose, and state the fallback reason. Provenance does not relax any gate:
upstream-first routing, renderer authority, GraphQL-first, strict CSP, the
review gate, and the branch contract below all still apply.

Trust model: the route is first-party EqualToAI/TheoryMCP steward-routing
infrastructure. Treat it as a remote trust boundary: send only scoped
repository/GitHub/mailbox data needed for the approved operation, never
secrets.

## What is this repo?

`contentus` is the **lesser CMS client** — a FaceTheory app installed into
lesser instances via `lesser client install`, delivering:

- the **public article reading surface** (`/articles/<slug>` and the public
  CMS pages lesser's contract defines), and
- the **authenticated authoring workflow**: create → draft → `draftPreview` →
  review → publish, over lesser's GraphQL CMS surface.

It is a citizen of the lesser ecosystem. Its predecessor (`emdash`) was
abandoned because it behaved as an arbitrary standalone application with no
deployment path in lesser; every constraint below exists to prevent that
failure shape.

## How Contentus fits into the EqualtoAI system

Sibling repositories (typically checked out next to this repo):

- `../lesser` — the backend: GraphQL (`/api/graphql`), realtime subscriptions,
  `auth-ui` at `/auth/*` (OAuth Authorization Code + PKCE), deployment and
  client install via the `lesser` CLI. **Owns the CMS contract and the
  renderer/sanitizer.** Canonical contract docs:
  - `docs/architecture/cms/fediverse-first-blog-cms-contract.md`
  - `docs/development/CMS_DEVELOPER_GUIDE.md`
- `../greater-components` — UI kit, faces, and adapters generated from lesser
  contracts, consumed vendored via the `greater` CLI.
- `../lesser-host` — hosting/control plane.
- `../lesser-body`, `../lesser-soul` — MCP surfaces and namespaces.
- `../simulacrum` — the social client and closest steward exemplar (`sim`).
- `../emdash` — abandoned first CMS attempt; negative exemplar only.

Notes:

- When referencing sibling repos, **ignore** `.pai/` and `.theory/` directories.
- Gaps in lesser contracts or greater-components are **upstream issues**, never
  local patches, REST workarounds, or vendored-file edits.
- Contentus owns no CMS contract; it keeps only thin consumption notes.

## Non-negotiable constraints (do not break)

- **Renderer authority is lesser's.** Article HTML for public pages, draft
  preview, and federated content comes from lesser's renderer/sanitizer
  (`draftPreview`, published Article output). Never render Markdown/HTML
  client-side; never display raw draft source.
- **GraphQL-first** for app functionality. Missing capability → stop and open
  an upstream issue. Exception: wallet/auth flows are intentionally REST-only
  per lesser policy.
- **Auth**: lesser `auth-ui` + OAuth Authorization Code + PKCE only. Do not
  re-implement auth inside the client.
- **Strict CSP compatibility**: no inline `<script>` or `<style>`.
- **Review gate is contractual.** Agent-generated drafts require explicit
  reviewer/publisher action through lesser's authenticated CMS workflow. Never
  auto-publish; never obscure the gate.
- **Deployment path is milestone zero.** `facetheory.lesser.json` and the
  `lesser client install` flow to a dev instance stay green from the first
  milestone onward. Instance-specific installs use a
  `facetheory.<instance>.lesser.json` manifest (gitignored) whose `app_name`
  matches the target instance slug.
- **Use pnpm** (avoid npm).
- **No hard-coded domains**: derive hosts from `window.location.origin`.

## Branch / profile contract

- Governance profile: `software_repo_gov_infra` (repo class
  `software_repo_steward`, `software_rubric_applied=true`).
- Base branch: `staging`. Milestone branches from `staging`; PRs target
  `staging`.
- Merge owner: **operator** (`self-forbidden`). The steward opens PRs and
  reports evidence; it never merges, force-pushes, deletes branches, deploys,
  signs, or mutates cloud/runtime state. `staging → main` is the operator's
  lane.
- Commits: Conventional Commits, milestone-scoped, and **signed off without
  exception** — see [DCO sign-off](#dco-sign-off-every-commit-no-exceptions).
- `run-rubric-gate` green at current HEAD before any push; gov-infra is CI-core
  and never retired. The repo-local spine is provisioned:
  - Verifier (single entrypoint): `bash gov-infra/verifiers/gov-verify-rubric.sh`
  - Evidence: `gov-infra/evidence/`, report
    `gov-infra/evidence/gov-rubric-report.json` in schema `gov_rubric_report.v1`
  - CI hook: `.github/workflows/gov-rubric.yml`, on pull requests to `staging`
  - A control that cannot run is **BLOCKED**, never PASS, and BLOCKED is not
    green. Never weaken a gate, add a blanket exclude, or simulate a result.
  - `SEC-2` and `SEC-7` assert *disclosed* upstream state, pinned exactly in
    `gov-infra/planning/contentus-disclosed-upstream-findings.json`. A PASS on
    either means "unchanged", not "clean". A new or altered finding is a thing
    to route upstream, never an entry to append without examining it.
  - Signing is retired for this lifecycle surface; namespace MCP guidance does
    not replace this repo-local CI.

### Bootstrap exception (expires at the M1 merge)

One head is exempt from "green at current HEAD before any push": the initial
gov-infra spine branch itself. The spine lands on a `staging` that has no
`package.json`, no lockfile, no `src/`, and no build, so every control that
invokes the toolchain fails for a structural reason — the application has not
merged yet. Committing a green report at that ref would require either faking it
or weakening the gates, and both are worse than a red one.

The green evidence for the spine is therefore the composite run: the spine's
verifiers against the M1 application tree, run by Factory, with its own report
and its own preserved logs in `gov-infra/evidence/composite-m1-spine/`. The red
report committed on the spine branch is the honest result for the spine ref and
is committed as such.

What the red report contains, stated exactly, because "substantive" is otherwise
a word each reader fills in differently. Every FAIL on the spine ref is a control
whose command could not find the application: no `package.json`, so nothing to
run; no lockfile, so nothing to install; no `src/`, so nothing to build, type,
lint, or probe. The one BLOCKED is SEC-7, whose digest-verified `greater` release
asset is fetched by the CI step and is absent on a bare checkout of this ref, so
there is no archive for the gate to extract and execute — the control could not
run, which is what BLOCKED means. There is no FAIL on this ref
where a gate ran against the artifact it judges and disagreed with it. That is
the precise property this exception rests on, and if a future run of this ref
ever produced one, the exception would not cover it.

This exception covers exactly this one head. It expires when M1 merges to
`staging` — from that point the toolchain is present, the composite and the ref
are the same tree, and the absolute rule above applies with no exception. It is
not a precedent for any later branch.
- Cross-client adversarial review applies to PRs per the fleet pattern; the
  implementing client never reviews its own change.

## DCO sign-off (every commit, no exceptions)

Every commit in this repository carries a `Signed-off-by` trailer naming the
identity that **authors** it. No condition is attached to that sentence: not the
branch, not whether the change is code or docs, not whether a gate is believed
to be watching. Deciding per-branch whether sign-off is needed is the failure
mode; the sign-off itself costs nothing.

The **canonical rule is the bank skill `run-rubric-gate` (v2)**, assigned to the
contentus steward. Read it there. This section points at it and deliberately
does not restate it — what follows is only what a contributor to *this* repo
needs at hand.

- **Local git:** `git commit -s`. Check `user.name` / `user.email` first — the
  trailer must carry the identity that will author the commit.
- **Governed `github_commit_files` route:** the tool takes a message and has no
  `-s`. Author the `Signed-off-by` trailer into the message yourself, as the
  routed bot identity that will author the commit — never a human identity. On
  that route the commit *is* the push, so get the trailer right on the first
  commit and read it back before adding more.
- **Every history operation re-authors commits.** After a rebase, cherry-pick,
  squash, or amend, verify again.

**Verify before every push, and paste the output into the PR or the report:**

```bash
git log --no-merges --format='%H %ae %(trailers:key=Signed-off-by,valueonly,separator=%x2C)' <base>..HEAD
node scripts/dco-check.mjs <base-sha> <head-sha>
```

Every commit must show a trailer whose email matches its author. "All signed" is
a claim; that output is the evidence — and the claim has been made in this repo
and been false. Never report commits as signed without it.

`scripts/dco-check.mjs`, the gate CI runs (`.github/workflows/dco.yml`), is
**presence-only**: it accepts any well-formed `Signed-off-by: Name <email>` on
every non-merge commit and does not compare the trailer against the commit's
author. The rule stated above is stricter than that gate on purpose. Signing off
as the authoring identity satisfies this repo's gate and the stricter ones
elsewhere in the fleet at the same time, so there is never a reason to aim at
the looser one.

**Assume there is no remediation path.** This repo has no DCO
remediation-commit mechanism: a later signed commit does not repair an earlier
unsigned one, and the only repair is rewriting history. **If you find unsigned
commits already pushed, stop and report.** The rewrite, and the force-push it
requires, is operator-authorized — never a steward's own call. It also
invalidates every SHA already cited in the PR body, evidence comments, and gov
evidence commits, so the rubric must be re-run and every citation refreshed
afterwards.

Why this is written down: PR #57 produced **two** unsigned-commit incidents, and
each one required an operator-authorized history rewrite to repair. Both began
with an unexamined answer to "does this branch need sign-off?" — which is why
the rule above leaves no condition to examine.

## Modes of work

- **Mode 1** — changing contentus (the app, the repo, or the steward):
  `scope-need` first, one concern per change, specialist walks per the
  steward's skill fleet (`validate-cms-consumption`,
  `enforce-renderer-authority`, `install-contentus-instance`,
  `route-upstream-issue`, …).
- **Mode 2** — none. Contentus is a product steward, not an agent producer.

## Repo map (genesis)

- `facetheory.lesser.json` — lesser install manifest for the FaceTheory app
- `docs/runbook.md` — build/install/verify runbook (operator-run installs;
  steward sequences, verifies, records)
- `gov-infra/` — the governance spine: `verifiers/` (the rubric entrypoint and
  its checkers), `planning/` (threat model, controls matrix, evidence plan,
  rubric, roadmap, disclosed upstream findings), `evidence/` (regenerated by
  the verifier, never hand-edited), `.tools/` (the pinned `greater` release
  asset, which is not on the npm registry, plus a local install of it for
  development). **The verifier does not trust `.tools/` and does not run what
  `install-greater-cli.mjs` installs.** That script is a repository file the
  pull request under review can edit, so what SEC-7 consumes from it is only the
  digest-verified tarball: the gate re-verifies that asset, extracts its own
  quarantined copy, and executes that. Verifying one artifact while running
  another binds nothing.
- `.github/workflows/` — pull-request CI; every action pinned by immutable
  commit SHA
- `.codex/`, `.agents/`, `.claude/`, `.kimi-code/`, `GEMINI.md`, `.mcp.json` —
  materialized steward trees (generated; do not hand-edit)
- `src/`, `static/`, `package.json` — land with the app milestones

## Refusals the steward will give (so don't ask)

- "Build the screen first, wire it to lesser later."
- "We'll figure out deployment at the end."
- "Render the Markdown client-side, it's faster / previews nicer."
- "Just add a small REST endpoint / tiny local backend for this one thing."
- "Show the raw draft for review, skip `draftPreview`."
- "Reimplement auth inside the client."
- "Let the agent's draft auto-publish just this once."
- "Patch the vendored greater-components file / fake the contract locally."
- "Skip the rubric / review / install verification just this once."
