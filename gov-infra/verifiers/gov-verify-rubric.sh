#!/usr/bin/env bash
# GovTheory Rubric Verifier (Single Entrypoint)
# Rendered from namespace pack bc41187efb6f5b3c3bfb4d9295836d4e071941d7 for contentus.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# Evidence lands in gov-infra/evidence by default. GOV_EVIDENCE_DIR selects a
# direct subdirectory of it instead, which is how a composite run (these verifiers
# against another tree) keeps its logs beside — never on top of — the logs for this
# ref. Regenerating evidence deletes what it is about to replace, so two runs
# sharing one directory means the second run's report cites the first run's logs.
# The value is constrained to a direct child so it can never redirect evidence
# outside the tree the CI artifact upload covers, and it can only relocate output:
# no control's PASS/FAIL depends on it.
EVIDENCE=gov-infra/evidence
if [[ -n "${GOV_EVIDENCE_DIR:-}" ]]; then
  case "$GOV_EVIDENCE_DIR" in
    gov-infra/evidence/*/*|*..*|/*) echo "GOV_EVIDENCE_DIR must be gov-infra/evidence or a direct subdirectory of it (got $GOV_EVIDENCE_DIR)" >&2; exit 2;;
    gov-infra/evidence|gov-infra/evidence/*) EVIDENCE="$GOV_EVIDENCE_DIR";;
    *) echo "GOV_EVIDENCE_DIR must be gov-infra/evidence or a direct subdirectory of it (got $GOV_EVIDENCE_DIR)" >&2; exit 2;;
  esac
fi
PLAN=gov-infra/planning
VERIFY=gov-infra/verifiers
TOOLS=gov-infra/.tools
REPORT="$EVIDENCE/gov-rubric-report.json"
PIN="$PLAN/contentus-disclosed-upstream-findings.json"
# A control that cannot run reports BLOCKED, never PASS. `run` only honours this
# exit code when the control also emitted the sentinel, so an ordinary command
# that happens to exit 3 is still a FAIL.
BLOCKED_RC=3
BLOCKED_SENTINEL='GOV-BLOCKED:'
# WHICH SOURCE THIS RUN IS EVIDENCE OF, read BEFORE any control runs and before
# the evidence directory is touched, so it names the tree the controls actually
# scanned rather than the one they left behind.
#
# A REPORT CANNOT CONTAIN THE SHA OF THE COMMIT THAT CARRIES IT. The gate runs,
# writes this file, and the file is committed afterwards — so a committed report
# names the PARENT of its own commit. That is the honest binding and it is the
# one recorded here: `source.sha` is checkable against
# `git log -1 --format=%P <the commit that added this report>`. A timestamp binds
# nothing, which is what made "evidence at its own HEAD" an unverifiable claim.
#
# `worktree` reports whether anything OTHER than evidence was uncommitted when
# the run started. A `modified` run is still a real run, and saying so is the
# difference between evidence for a commit and evidence for somebody's desk.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  SOURCE_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
  SOURCE_TREE="$(git rev-parse 'HEAD^{tree}' 2>/dev/null || echo '')"
  if [[ -n "$(git status --porcelain -- . ':(exclude)gov-infra/evidence' 2>/dev/null)" ]]; then
    SOURCE_WORKTREE=modified
  else
    SOURCE_WORKTREE=clean
  fi
else
  SOURCE_SHA='' SOURCE_TREE='' SOURCE_WORKTREE=unknown
fi
mkdir -p "$EVIDENCE" "$TOOLS/bin"
rm -f "$REPORT" "$EVIDENCE"/*-output.log "$EVIDENCE/DOC-5-parity.log"
declare -a RESULTS=()
pass=0 fail=0 blocked=0
escape() { node -p 'JSON.stringify(process.argv[1])' "$1"; }
# A value the run could not read is `null`, never an empty string: "" is a value
# and would read as "the gate ran against nothing".
escape_or_null() { [[ -z "$1" ]] && printf 'null' || escape "$1"; }
record() { local id=$1 category=$2 status=$3 message=$4 evidence=$5; case "$status" in PASS) ((pass++)) || true;; FAIL) ((fail++)) || true;; BLOCKED) ((blocked++)) || true;; *) exit 2;; esac; RESULTS+=("{\"id\":$(escape "$id"),\"category\":$(escape "$category"),\"status\":$(escape "$status"),\"message\":$(escape "$message"),\"evidencePath\":$(escape "$evidence")}"); }
run() {
  local id=$1 category=$2 command=$3 out="$EVIDENCE/$1-output.log"
  if [[ "$command" == TODO:* || -z "$command" ]]; then printf '%s\n' "$command" > "$out"; record "$id" "$category" BLOCKED "Verifier command not configured" "$out"; return; fi
  set +e; ( set -o pipefail; eval "$command" ) >"$out" 2>&1; local rc=$?; set -e
  if [[ $rc -eq 0 ]]; then record "$id" "$category" PASS "Command succeeded" "$out"
  elif [[ $rc -eq $BLOCKED_RC ]] && grep -q "^$BLOCKED_SENTINEL" "$out"; then record "$id" "$category" BLOCKED "$(grep -m1 "^$BLOCKED_SENTINEL" "$out" | cut -c14-)" "$out"
  else record "$id" "$category" FAIL "Command failed with exit code $rc" "$out"; fi
}

check_supply_chain() {
  # GitHub Actions must be immutable: each structured YAML `uses` value is
  # either a local ./ action whose manifest is scanned under these same rules,
  # or a 40-hex commit SHA. The scanner is deliberately fixed to
  # .github/workflows; no environment override can subtract coverage.
  echo "Scanning workflow directory: .github/workflows"
  node "$VERIFY/validate-workflows.mjs" --uses || return 1
  # Least-privilege permissions and the prohibition on splicing event payload
  # text into `run:` blocks. A workflow that can write is a supply-chain surface.
  node "$VERIFY/validate-workflows.mjs" --policy || return 1
  [[ -f pnpm-lock.yaml ]] || { echo 'missing pnpm-lock.yaml'; return 1; }
  # Every install in this rubric disables lifecycle scripts. That ordering, not
  # the screening below it, is the control: nothing installed here ever executes.
  set +e
  pnpm install --frozen-lockfile --ignore-scripts
  local install_rc=$?
  set -e
  if [[ $install_rc -ne 0 ]]; then echo "pnpm install --frozen-lockfile --ignore-scripts failed with exit code $install_rc" >&2; return 1; fi
  local pkg_json_list; pkg_json_list="$(mktemp)"
  find node_modules -type f -name package.json 2>/dev/null > "$pkg_json_list" || { rm -f "$pkg_json_list"; return 1; }
  set +e
  node "$VERIFY/check-supply-chain.mjs" "$pkg_json_list"
  local scan_rc=$?; set -e; rm -f "$pkg_json_list"; [[ $scan_rc -eq 0 ]]
}

# SEC-2: the audit runs in full over the whole installed graph — not `--prod`,
# because dev dependencies execute in CI against this checkout. The assertion is
# that its high/critical set is exactly the pinned disclosed set. `pnpm audit`
# exits non-zero when it reports anything, so its status is deliberately ignored
# in favour of its output.
check_disclosed_audit() {
  local out; out="$(mktemp)"
  set +e
  pnpm audit --audit-level=high --json > "$out" 2>/dev/null
  set -e
  node "$VERIFY/check-disclosed-audit.mjs" "$out"
  local rc=$?
  rm -f "$out"
  return $rc
}

# SEC-7: vendored integrity through the pinned `greater` CLI. The CLI is not on
# the npm registry, so provenance cannot come from a package manager and must not
# come from the tool's own `--version` output — any binary can print a version.
# It cannot come from the repo-local install either: `install-greater-cli.mjs` is
# an ordinary repository file, so a pull request that appends a few lines to it can
# replace the unpacked executable after the digest check and leave the contract,
# the workflow and the tarball untouched. Verifying one artifact and executing
# another binds nothing. So the pinned release asset is the sole root of trust and
# the checker below extracts its own copy of it into a quarantine at gate time and
# runs `--version` and `doctor` from that. Nothing under $TOOLS is executed. No
# verifiable provenance is BLOCKED, never PASS; a digest, an archive member or a
# version that resolves and disagrees is a FAIL, because the gate ran.
check_greater_integrity() {
  if command -v greater >/dev/null 2>&1; then
    echo "note: a PATH \`greater\` exists ($(command -v greater)) and is deliberately not used."
  fi
  if [[ -e "$TOOLS/node_modules/.bin/greater" ]]; then
    echo "note: a repo-local install exists under $TOOLS and is deliberately not executed;"
    echo "      SEC-7 runs only what it extracts itself from the digest-verified tarball."
  fi
  set +e
  node "$VERIFY/check-greater-provenance.mjs"
  local rc=$?
  set -e
  return $rc
}

check_parity() {
  local out="$EVIDENCE/DOC-5-parity.log" missing=0 threat_ids
  : > "$out"
  threat_ids="$(grep -oE 'THR-[0-9]+' "$PLAN/contentus-threat-model.md" | sort -u)" || return 1
  [[ -n "$threat_ids" ]] || return 1
  while IFS= read -r t; do
    grep -q "$t" "$PLAN/contentus-controls-matrix.md" || { echo "unmapped $t" >> "$out"; missing=1; }
  done <<< "$threat_ids"
  [[ $missing -eq 0 ]]
}

check_ci_hook() {
  grep -R -q 'gov-verify-rubric.sh' .github/workflows || return 1
  node "$VERIFY/validate-workflows.mjs" --triggers || return 1
  node --input-type=module -e "import { validateRequiredWorkflows } from './$VERIFY/validate-workflows.mjs'; const findings = validateRequiredWorkflows(); if (findings.length) { console.error(findings.join('\\n')); process.exit(1); }" || return 1
}

# --- Quality ------------------------------------------------------------------
# Ordering is load-bearing: the SSR probes drive build/server/handler.mjs and the
# uncompiled-rune guard walks build/, where an absent build passes vacuously.
# The build runs first and COM-1 asserts the artifacts it should have produced.
run QUA-1 Quality 'pnpm run build'
run QUA-2 Quality 'pnpm test'
run QUA-3 Quality 'pnpm run svelte-check'

# --- Consistency --------------------------------------------------------------
run CON-1 Consistency 'pnpm run lint'
run CON-2 Consistency 'pnpm run typecheck'
run CON-3 Consistency "node $VERIFY/check-install-manifest.mjs"
run CON-4 Consistency "node $VERIFY/check-greater-pins.mjs"
# Every control above that trusts `pnpm run <name>` trusts a file the same pull
# request can edit. CON-5 binds those scripts to their pinned definitions, so a
# script stubbed to `true` fails the report instead of turning it green.
run CON-5 Consistency "node $VERIFY/check-package-scripts.mjs"

# --- Completeness -------------------------------------------------------------
run COM-1 Completeness "node $VERIFY/check-install-manifest.mjs --artifacts"
run COM-2 Completeness 'node -e "const p=require(\"./package.json\"); if(!/^>=24/.test(p.engines?.node||\"\")) process.exit(1);" && grep -q "lockfileVersion: '\''9.0'\''" pnpm-lock.yaml'
run COM-3 Completeness 'test -s AGENTS.md && test -s README.md && test -s docs/runbook.md'
run COM-4 Completeness 'test -f .github/workflows/gov-rubric.yml && test -f .github/workflows/test.yml && test -f .github/workflows/lint.yml && test -f .github/workflows/codeql.yml && test -f .github/workflows/dco.yml && test -f .github/workflows/main-guard.yml'
run COM-5 Completeness 'pnpm install --frozen-lockfile --ignore-scripts'

# --- Security -----------------------------------------------------------------
run SEC-1 Security 'test -f .github/workflows/codeql.yml && grep -q "github/codeql-action/init@[0-9a-f]\{40\}" .github/workflows/codeql.yml'
run SEC-2 Security check_disclosed_audit
run SEC-3 Security check_supply_chain
run SEC-4 Security 'pnpm run validate:csp'
run SEC-5 Security 'pnpm run validate:renderer-authority'
run SEC-6 Security "node $VERIFY/check-security-tests.mjs"
run SEC-7 Security check_greater_integrity

# --- Compliance ---------------------------------------------------------------
for x in controls-matrix evidence-plan threat-model; do f="$PLAN/contentus-$x.md"; id=CMP-1; [[ $x == evidence-plan ]]&&id=CMP-2; [[ $x == threat-model ]]&&id=CMP-3; [[ -f $f ]] && record "$id" Compliance PASS 'File exists' "$f" || record "$id" Compliance FAIL 'Required file missing' "$f"; done

# --- Maintainability ----------------------------------------------------------
run MAI-1 Maintainability "test -s $VERIFY/gov-verify-rubric.sh"
run MAI-2 Maintainability "test -s $PLAN/contentus-10of10-roadmap.md"
run MAI-3 Maintainability 'test "$(find gov-infra/verifiers -name "gov-verify-rubric.sh" | wc -l | tr -d " ")" = 1'
run MAI-4 Maintainability check_ci_hook

# --- Docs ---------------------------------------------------------------------
for x in threat-model evidence-plan 10of10-rubric; do f="$PLAN/contentus-$x.md"; id=DOC-1; [[ $x == evidence-plan ]]&&id=DOC-2; [[ $x == 10of10-rubric ]]&&id=DOC-3; [[ -f $f ]] && record "$id" Docs PASS 'File exists' "$f" || record "$id" Docs FAIL 'Required file missing' "$f"; done
if check_parity; then record DOC-5 Docs PASS 'All threat IDs mapped in controls matrix' "$EVIDENCE/DOC-5-parity.log"; else record DOC-5 Docs FAIL 'Threat/control parity failed' "$EVIDENCE/DOC-5-parity.log"; fi
run DOC-4 Docs "test -s README.md && test -s $PIN && ! grep -R -q '{{[A-Z_][A-Z_]*}}' $PLAN"

status=PASS; [[ $fail -gt 0 ]] && status=FAIL; [[ $blocked -gt 0 && $fail -eq 0 ]] && status=BLOCKED
printf -v joined '%s,' "${RESULTS[@]}"; joined="[${joined%,}]"
source_note='The commit this run scanned, read before any control ran. Evidence is committed after the run, so in a committed report this names the PARENT of the commit carrying it, never that commit itself; check it with git log -1 --format=%P on the evidence commit. worktree reports whether anything outside gov-infra/evidence was uncommitted when the run started.'
cat > "$REPORT" <<EOF2
{"\$schema":"https://gov.pai.dev/schemas/gov-rubric-report.schema.json","schemaVersion":1,"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","source":{"sha":$(escape_or_null "$SOURCE_SHA"),"tree":$(escape_or_null "$SOURCE_TREE"),"worktree":"$SOURCE_WORKTREE","note":$(escape "$source_note")},"pack":{"version":"bc41187efb6f5b3c3bfb4d9295836d4e071941d7","digest":"a613e19a4367d98a8f4b45f7c19c11881d21491eb55b8409446ca4a10d4e5cd7"},"project":{"name":"contentus","slug":"contentus"},"summary":{"status":"$status","pass":$pass,"fail":$fail,"blocked":$blocked},"results":$joined}
EOF2
# Validate the document, then rewrite it indented. Evidence is committed and this
# repository lints everything it commits, so a report that is only valid JSON puts
# the next run's CON-1 at odds with the previous run's output. Two-space indent is
# what Prettier produces for this shape, so the generated file is already clean.
node -e 'const fs=require("fs"),p=process.argv[1];fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p,"utf8")),null,2)+"\n");' "$REPORT"
echo "Report written to $REPORT: $status ($pass pass, $fail fail, $blocked blocked)"
[[ $status == PASS ]]
