# Contentus Client Install Runbook

This runbook covers building the Contentus FaceTheory app and installing it
into lesser instances via the lesser installed-client flow. Installs are
**operator-run**; the contentus steward sequences, verifies, and records — it
never executes a deploy itself.

## Current install path

Contentus ships only through the installed-client flow:

- build outputs live under `build/server` and `build/client`
- installation uses `lesser client install`
- the checked-in manifest template is `facetheory.lesser.json`
- installs to a specific instance use an instance-specific manifest
  `facetheory.<instance>.lesser.json` (gitignored) whose `app_name` matches the
  target instance slug

```bash
pnpm install
pnpm build
lesser client install --manifest facetheory.<instance>.lesser.json --target <instance>
```

## Prereqs

- `node >= 24`
- `pnpm`
- a current `lesser` binary that supports `lesser client install` (see the
  simulacrum runbook `../simulacrum/docs/runbook.md` for how to obtain one —
  do not assume the binary on `PATH` is new enough)
- AWS access for the target instance profile
- `curl`

## Targets

v1 verification target:

| instance | stage | notes |
| --- | --- | --- |
| `trenchcoat` | dev | deployed from `lab.lesser.host`; CMS long-form gates enabled. Stage URL and local receipt path are recorded here at first verified install. |

The manifest and this runbook are instance-parameterized from day one:
expanding to further dev instances is a new manifest file plus a row in this
table, not a code change. Do not use this runbook for production-customer
lesser instances.

## Post-install verification (the smoke test of record)

CI-green alone is never "done". After each install, verify against the live
instance:

1. **Public reading surface** — article routes render HTML produced by
   lesser's renderer/sanitizer (server-rendered, not client-composed).
2. **Auth flow** — OAuth Authorization Code + PKCE against the instance's
   `auth-ui` completes; no client-local auth appears anywhere in the flow.
3. **Authoring workflow** — create draft → `draftPreview` (server-rendered
   preview, never raw draft source) → review gate is visible and honest →
   publish requires explicit reviewer/publisher action.
4. **GraphQL-first** — no REST calls in app flows other than the wallet/auth
   exception per lesser policy.
5. **CSP** — browser console shows no CSP violations on the installed routes.

Record the install outcome (instance, manifest `app_name`, version, evidence)
in the steward's memory ledger.

## Milestone-zero discipline

The manifest and this install path are milestone-zero artifacts: they exist
from the first milestone and must stay green at every milestone boundary. A
broken install path blocks feature work — "we'll figure out deployment at the
end" is the failure mode this repo exists to avoid.
