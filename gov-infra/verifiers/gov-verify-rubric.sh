#!/usr/bin/env bash
# GovTheory Rubric Verifier (Single Entrypoint)
# Rendered from namespace pack bc41187efb6f5b3c3bfb4d9295836d4e071941d7 for contentus.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
EVIDENCE=gov-infra/evidence
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
mkdir -p "$EVIDENCE" "$TOOLS/bin"
rm -f "$REPORT" "$EVIDENCE"/*-output.log "$EVIDENCE/DOC-5-parity.log"
declare -a RESULTS=()
pass=0 fail=0 blocked=0
escape() { node -p 'JSON.stringify(process.argv[1])' "$1"; }
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
# the npm registry, so the repo-local pinned install is preferred and PATH is a
# fallback. Neither resolving is BLOCKED, never PASS — but a CLI that resolves at
# the wrong version is a different thing entirely: it reports on a tree it does
# not match, so a version mismatch is a FAIL, not a BLOCKED.
check_greater_integrity() {
  local cli="" origin=""
  if [[ -x "$TOOLS/node_modules/.bin/greater" ]]; then cli="$TOOLS/node_modules/.bin/greater"; origin="repo-local pinned install"
  elif command -v greater >/dev/null 2>&1; then cli="$(command -v greater)"; origin="PATH fallback"; fi
  if [[ -z "$cli" ]]; then
    echo "${BLOCKED_SENTINEL} greater CLI not resolvable; SEC-7 could not run"
    echo "The CLI is not published to the npm registry. Install the pinned release asset:"
    echo "  npm install --no-save --prefix $TOOLS \\"
    echo "    https://github.com/equaltoai/greater-components/releases/download/greater-v0.11.9/greater-components-cli.tgz"
    echo "BLOCKED is not green: this report will not pass."
    return $BLOCKED_RC
  fi
  local want; want="$(node -p 'JSON.parse(require("fs").readFileSync("gov-infra/planning/contentus-pinned-repo-contract.json","utf8")).greater?.cli_version ?? ""' 2>/dev/null)" || want=""
  local got; got="$("$cli" --version 2>/dev/null | tr -d '[:space:]')"
  echo "greater CLI: $cli ($origin) version=${got:-unavailable}, pinned ${want:-unset}"
  if [[ -z "$want" ]]; then echo 'greater.cli_version is not pinned in the repo contract' >&2; return 1; fi
  if [[ "$got" != "$want" ]]; then
    echo "greater CLI version mismatch: resolved '${got:-none}' via $origin, pin requires '$want'." >&2
    echo "A CLI at another version audits the vendored tree against the wrong manifest." >&2
    echo "This is a FAIL, not BLOCKED: the gate ran and disagreed." >&2
    return 1
  fi
  local out; out="$(mktemp)"
  set +e
  "$cli" doctor --json > "$out" 2>/dev/null
  set -e
  node "$VERIFY/check-greater-doctor.mjs" "$out"
  local rc=$?
  rm -f "$out"
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
cat > "$REPORT" <<EOF2
{"\$schema":"https://gov.pai.dev/schemas/gov-rubric-report.schema.json","schemaVersion":1,"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","pack":{"version":"bc41187efb6f5b3c3bfb4d9295836d4e071941d7","digest":"a613e19a4367d98a8f4b45f7c19c11881d21491eb55b8409446ca4a10d4e5cd7"},"project":{"name":"contentus","slug":"contentus"},"summary":{"status":"$status","pass":$pass,"fail":$fail,"blocked":$blocked},"results":$joined}
EOF2
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]));' "$REPORT"
echo "Report written to $REPORT: $status ($pass pass, $fail fail, $blocked blocked)"
[[ $status == PASS ]]
