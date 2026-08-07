# Contentus Client Install Runbook

This runbook covers building the Contentus FaceTheory app and installing it
into lesser instances via the lesser installed-client flow. Installs are
**operator-run**; the contentus steward sequences, verifies, and records — it
never executes a deploy itself.

## Current install path

Contentus ships only through the installed-client flow:

- build outputs live under `build/server` and `build/client`
- installation uses `lesser client install`
- the checked-in manifest is `facetheory.lesser.json`

```bash
pnpm run deploy -- \
  --app <instance-slug> \
  --base-domain <base-domain> \
  --stage <dev|staging|live> \
  --aws-profile <profile>
```

The generic entrypoint performs the frozen-lockfile install, `svelte-check`,
build, artifact assertions, `lesser client install`, and the post-install
`curl`. It always delegates the install with `--config
facetheory.lesser.json --skip-build`; the build has already completed and been
checked before lesser receives it.

### How instance targeting actually works

Verified against `cmd/lesser/client_install.go` at the pinned lesser checkout,
which is authoritative over any prose here:

- Required flags are `--app`, `--base-domain`, and `--aws-profile`. There is no
  `--manifest` flag and no `--target` flag; the manifest is passed with
  `--config`, and the instance is chosen by `--app` + `--base-domain`.
- The manifest's `app_name` is the **client** app name (`contentus`) — it is
  recorded as `stages.<stage>.client_install.app_name` in the receipt. It is
  **not** the instance slug.

So **one committed manifest serves every instance**: targeting is entirely a
matter of command-line flags. This is stronger instance-parameterization than
per-instance manifest files, and it means no instance name appears anywhere in
the repo. `facetheory.*.lesser.json` remains gitignored for the case where an
operator needs a one-off local override via `--config`.

## Prereqs

- `node >= 24`
- `pnpm`
- a current `lesser` binary on `PATH` that supports `lesser client install`
- AWS access for the target instance profile
- `curl`

## Config-free deploy entrypoint

An already-deployed lesser instance needs no registration in this repository.
An operator supplies its four values at invocation time:

- `--app`: the lesser instance slug
- `--base-domain`: the instance base domain
- `--stage`: `dev`, `staging`, or `live`
- `--aws-profile`: the AWS profile that can update that instance

The instance must already have a lesser deployment receipt whose selected
stage includes `FrontendDistributionId`. `ClientBucketName`,
`ClientArtifactBucketName`, and `ClientInstallManifestKey` are advisory: the
entrypoint reports their absence and lesser derives them. By default the
entrypoint reads `~/.lesser/<app>/<base-domain>/state.json`; pass
`--state <path>` for a receipt stored elsewhere. The current `lesser` binary,
receipt, checked-in manifest, and (when `--skip-build` reuses a build) all
required artifacts are validated before any AWS operation. A missing
prerequisite stops with its path or binary name. A dry run from a fresh clone
does not require build artifacts because the real plan would create them;
adding `--skip-build` makes those artifacts a preflight requirement.

Preview the exact commands and derived stage origin without executing pnpm,
lesser, curl, AWS calls, or other network work:

```bash
pnpm run deploy -- \
  --app <instance-slug> \
  --base-domain <base-domain> \
  --stage <dev|staging|live> \
  --aws-profile <profile> \
  --dry-run
```

`--skip-install` reuses installed dependencies. `--skip-build` reuses build
artifacts and runs a standalone `svelte-check`; combine it with `--skip-check`
only when that check has already run. Artifact assertions still run before
install. After a real install the entrypoint curls `/l/` at
`https://<stage>.<base-domain>` for `dev` and `staging`, or at the apex
`https://<base-domain>` for `live`. That bounded curl requires HTTP 200; it is
the automated availability check. Continue with the smoke test below for the
CMS, auth, GraphQL, CSP, and renderer-authority evidence of record.

Adding an instance therefore costs only the same four CLI values and an
already-deployed lesser instance with `FrontendDistributionId`: no target map,
package script, manifest, or runbook edit.

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

### M1 scope of that checklist

M1 ships the brand layer, the shell, and Face 1 (Articles). Items 3 is not yet
in scope — the authoring and review surfaces are Face 2 (M2). For the M1
install, verify items 1, 2, 4, and 5, plus:

```bash
# 1. Public index server-renders (no SPA fallback exists under /l/*).
curl -sS -D- https://dev.<base-domain>/l/ -o /dev/null

# 2. A deep route server-renders cold, and carries a strict CSP.
curl -sS -D- https://dev.<base-domain>/l/articles/<slug> -o /dev/null \
  | grep -i content-security-policy

# 3. An unknown surface is a real 404, not a 200 with apologetic copy.
curl -sS -o /dev/null -w '%{http_code}\n' https://dev.<base-domain>/l/no-such-surface

# 4. The brand stylesheet and assets resolve from /l/_assets/.
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://dev.<base-domain>/l/_assets/brand/contentus.css

# 5. Hydration data is external, same-origin JSON, and uncached.
curl -sS -D- 'https://dev.<base-domain>/l/_facetheory/hydration?path=%2F' -o /dev/null
```

Then in a browser, on `/l/` and `/l/articles/<slug>`:

- the console reports **no CSP violations**;
- the page renders on the Midnight ground with the journal (Phi Gold) accent —
  if it renders light-themed, the brand bridge did not load;
- the nav shows Articles / Timelines / Agents while signed out, and adds
  Review / Messages after sign-in;
- narrowing the viewport below 960px collapses the shell to one column.

**Expected M1 caveat.** If the instance's articles were authored as Markdown,
the reader will show "This article is awaiting server-rendered output" rather
than prose. That is correct, deliberate behaviour, not an install failure — see
`docs/consumption/renderer-authority.md`. Verifying the rendered-prose path
requires either an HTML-format article or the upstream lesser fix.

## Milestone-zero discipline

The manifest and this install path are milestone-zero artifacts: they exist
from the first milestone and must stay green at every milestone boundary. A
broken install path blocks feature work — "we'll figure out deployment at the
end" is the failure mode this repo exists to avoid.
