# contentus Threat Model (custom — v1.0.0)

## Scope

- **System:** the FaceTheory + greater-components **lesser CMS client** — a pnpm/Vite
  two-pass (client + SSR) build installed into a lesser instance only through
  `lesser client install`. It serves the public article reading surface and, once the
  authoring milestones land, the authenticated draft → preview → review → publish
  workflow over lesser's GraphQL CMS surface.
- **In-scope data:** server-rendered article HTML received from lesser, route and head
  output produced by the SSR handler, the vendored greater-components tree, the pinned
  dependency graph, the install manifest, and CI runtime configuration.
- **Out of scope:** lesser's CMS contract, its renderer/sanitizer, its persistence and
  federation, `auth-ui` itself, greater-components source, FaceTheory internals,
  lesser-host provisioning, key custody, and any cloud or on-chain state. Contentus owns
  none of these and routes defects to their stewards.
- **Environments:** local development, `staging` pull-request CI, operator-run installs
  against the trenchcoat dev instance, and operator-owned promotion to `main`.
- **Third parties:** GitHub Actions, the pnpm registry, greater-components and FaceTheory
  release tarballs, and the `greater` CLI.
- **Assurance target:** audit-ready repository controls.

## Assets and trust boundaries

- **Assets:** the renderer-authority invariant, the SSR trust boundary between the edge
  and the handler, a reproducible installable build, the vendored-source pin, and PR
  evidence.
- **Trust boundaries:** contributor changes; the lesser instance's GraphQL responses
  (remote, untrusted-until-typed); the HTTP request as it reaches the SSR handler
  (`Host` and forwarded headers are attacker-controllable unless the edge verified
  them); package release tarballs; GitHub Actions; and — the boundary THR-9 names — the
  repository's own gate-facing artifacts, which the change under review can edit in the
  same commit that the gate is meant to judge.
- **Entry points:** pull requests to `staging`. No workflow runs on direct pushes.

| Threat ID | Title                         | What can go wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Primary controls                         | Verification                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| THR-1     | Supply-chain compromise       | A mutable Action, a lifecycle hook, or an unlocked dependency executes in CI — including through a CI install that quietly drops `--ignore-scripts` before the rubric can object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | SEC-3, COM-2                             | `check_supply_chain`, pinned install invocations                                                                                                                                                                                                                                                 |
| THR-2     | Client regression             | SSR routes, types, Svelte components, or the two-pass build regress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | QUA-1, QUA-2, CON-2                      | build, tests, type checks                                                                                                                                                                                                                                                                        |
| THR-3     | Web-integrity regression      | Built output introduces inline scripts, styles, or event handlers, or a third-party script origin, breaking the strict CSP the FaceTheory host enforces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | SEC-4                                    | built-output CSP audit                                                                                                                                                                                                                                                                           |
| THR-4     | Governance drift              | The deterministic rubric or the pull-request CI hook disappears or goes stale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | MAI-4, DOC-5                             | CI-hook and threat/control parity checks                                                                                                                                                                                                                                                         |
| THR-5     | Renderer-authority violation  | A Markdown or HTML rendering path, a client-side excerpt/TOC generator, or a raw-draft-source display appears in the client, creating a second canonical renderer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | SEC-5                                    | `pnpm run validate:renderer-authority`                                                                                                                                                                                                                                                           |
| THR-6     | SSR trust-boundary regression | The handler resolves its origin from an unverified `Host`, leaks withheld article source, or serves 200 for a CMS object that does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | SEC-6                                    | built-handler SSR probes                                                                                                                                                                                                                                                                         |
| THR-7     | Vendored-source drift         | A vendored greater-components file is hand-edited, an orphan appears under the vendored root, or the CLI-copy and tarball channels drift out of lockstep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | SEC-7, CON-4                             | `greater doctor`, pin-lockstep check                                                                                                                                                                                                                                                             |
| THR-8     | Disclosed-finding drift       | A known, unfixed upstream finding silently changes shape, or a new finding hides behind an old one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | SEC-2, SEC-7                             | exact-set assertion against the pinned disclosures                                                                                                                                                                                                                                               |
| THR-9     | Gate self-neutralization      | The change under review edits what the rubric trusts — a `package.json` script, the file a pinned command _executes_, a probe's assertions, the install manifest, a pin — so a control exits 0 without its property holding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | CON-3, CON-4, CON-5, COM-1, SEC-6, SEC-7 | content hashes and shapes asserted against the pinned repo contract                                                                                                                                                                                                                              |
| THR-10    | Tool-provenance substitution  | The tool that produces a control's evidence is not the pinned tool. `greater` is not on the npm registry, so a PATH binary — or an unpacked tree an editable installer replaced after the digest check — prints the pinned version, emits a plausible `doctor` document, and satisfies the control while auditing nothing.                                                                                                                                                                                                                                                                                                                                                                                | SEC-7, MAI-4                             | the gate extracts and executes the digest-verified asset itself; unverifiable provenance is BLOCKED                                                                                                                                                                                              |
| THR-11    | Install-artifact escape       | A build artifact is a symlink rather than a file. Every lexical containment check still passes, and `lesser client install` follows the link on upload, packaging a file from the build host into the installed app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | CON-3, COM-1                             | real-path containment and a symlink walk of the artifact directories                                                                                                                                                                                                                             |
| THR-12    | Event-payload execution in CI | Attacker-authored pull-request text reaches a shell or interpreter in a workflow or a reached composite action. Refusing `${{ github.event.* }}` inside `run:` closes only the direct spelling; the `env:` indirection it recommends is a second path when the value is consumed as program text rather than as data; and every rule that asked _where in the shell_ the value ends up — the word a segment starts with, that word once wrappers are stripped, the proven command word of a parsed segment — was beaten by grammar, because execution is also in the argv of `find -exec`/`trap`/`awk`, in a `<(…)` script operand, on a non-zero file descriptor, behind `read`, and in YAML's own fold. | SEC-3, MAI-4                             | event-expression scan, composite `env:` prohibition, and an appearance rule: event-derived data may appear in a `run:` only as argv to a contract-pinned script or as an argument to `printf` after a literal format; every other appearance, and every `run:` that cannot be read, is a finding |

## Accepted coverage and semantic limits

These are the limits of what the gates above actually prove. They are recorded so that a
green report is read for what it is.

- **Renderer-authority audit scope.** `scripts/audit-renderer-authority.mjs` enforces two
  halves: no Markdown-rendering package enters the dependency graph, and the single
  body-resolution gate withholds anything that is not server-rendered HTML. It is a
  dependency-and-call-site audit, not a proof that no future component could render.
  Its strength depends on the audit keeping pace with new rendering surfaces.
- **CSP audit scope.** The audit fails on inline execution surfaces and reports external
  origins in built output across the seven audited routes. It is not a CSP header
  implementation and holds no origin allowlist; the header is enforced by the FaceTheory
  host, not by this repository.
- **SSR probe coverage.** `tests/ssr-probe.test.mjs` drives `build/server/handler.mjs`
  with stubbed GraphQL responses. It proves the built artifact's behaviour on the loaded
  path for the fixtures it supplies. It is not a live-instance test; install verification
  against the dev instance remains a separate, operator-run step.
- **Build-before-test ordering.** The SSR probes and the uncompiled-rune guard read
  `build/`. The rune guard walks an empty set when `build/` is absent and would pass
  vacuously, so the rubric runs the build (QUA-1) before the suite (QUA-2) and asserts
  the artifacts exist (COM-1). Running `pnpm test` alone against a clean checkout is not
  evidence.
- **`greater doctor` availability.** The `greater` CLI is not published to the npm
  registry. CI fetches the pinned `greater-v0.11.9` release asset into `gov-infra/.tools/`
  through `install-greater-cli.mjs`, which verifies its SHA-256 before unpacking. What
  SEC-7 consumes from that step is the tarball, not the tree: at gate time it re-verifies
  the asset, validates and extracts it into a quarantine of its own, and runs `--version`
  and `doctor` from there. A PATH `greater` is not accepted at any version and neither is
  the repo-local install — provenance by self-report is not provenance, and an editable
  installer is a self-report one step removed. If the digest-verified asset is absent,
  SEC-7 reports BLOCKED — never PASS.
- **Disclosed upstream findings.** SEC-2 and SEC-7 assert an exact finding set, not an
  empty one. Two findings are currently disclosed and unfixed upstream: a high-severity
  `ws` advisory reached through the pinned adapters tarball, and the blog face's
  unused-Markdown-chain dependency requirement. Neither gate proves the absence of the
  disclosed problem; each proves the problem has not changed and nothing new hides behind
  it. See `contentus-disclosed-upstream-findings.json`.
- **CodeQL.** The PR-only posture intentionally leaves no default-branch analysis, and
  fork PRs cannot upload `security-events`.
- **DCO.** The check proves a `Signed-off-by` trailer exists; it does not bind that
  trailer's identity to the commit author.
- **Promotion PR checks.** `staging` → `main` promotion PRs run only `main-guard` and
  DCO by design. The broader gates run on feature → `staging`. Branch protection on both
  branches is an operator-owned GitHub setting outside this repository.
- **Workflow structural sentinel limit.** MAI-4 verifies required sentinel tokens in
  line-oriented `run:`/`uses:` surfaces and rejects workflows whose recognized jobs are
  all `if: false`. It does not interpret arbitrary GitHub expression semantics; branch
  protection and CI execution remain separate enforcement. SEC-3 does follow `uses: ./`
  into local action manifests and applies the same pinning rules recursively, so a
  composite action cannot launder an unpinned reference through the local exemption.
- **Supply-chain screening is not detection.** The control SEC-3 rests on is that every
  `pnpm install` in this rubric and in CI carries `--ignore-scripts`, so no dependency
  lifecycle hook executes. The pattern scan over installed hooks — piped downloads,
  inline interpreters, process substitution, base64 decoding, token references — is
  heuristic screening layered above that boundary and would not catch a novel shape. It
  also asserts the two things `--ignore-scripts` does not cover: the root project's own
  lifecycle hooks, and pnpm's `.pnpmfile.cjs` and `onlyBuiltDependencies` escape hatches.
- **The install boundary is now asserted, not assumed.** The rubric could only ever fix
  its own install; the workflow installs run before it starts, so a CI install that
  dropped `--ignore-scripts` executed dependency code and the rubric then reported on the
  tree that code produced. SEC-3 asserts the exact text of every package-manager install
  in every workflow and in every local composite action a workflow reaches, against the
  invocations pinned in the repo contract. The `greater` CLI install is not among them
  because it now runs through a repository-local installer that verifies the release
  asset digest first and passes `--ignore-scripts` itself.
- **THR-9 is bounded by review, not by cryptography.** CON-5, the SEC-6 inventory, and
  the CON-3/CON-4 bindings all compare a repository artifact against a value pinned in
  `contentus-pinned-repo-contract.json`. An author who edits both the artifact and the
  pin still moves the gate. What the pin buys is that the edit has to land in
  `gov-infra/planning`, in the same diff, where it is the review's subject rather than an
  unremarkable line in an application file. The control it composes with is the
  cross-client adversarial review of the gov-infra diff — not the pin alone.

  This is the repository's convergence rule and it is load-bearing in both directions. A
  residual bypass that requires co-editing the pinned contract in the same diff is a
  documented limit, covered by mandatory cross-client review; a bypass that works
  _without_ touching the pinned contract is not a limit, it is a defect, and it is closed
  deterministically — by content hashes, not by command text. Every binding added under
  THR-9 exists because it fell on the second side of that line.

  **Amendment — operator ruling, 2026-07-31** (`equaltoai/contentus#50`,
  `issuecomment-5141933985`). Through rounds 1–7 the rule reserved documented residuals
  for that first case alone: needing the pinned contract moved was the only ground on
  which a residual could be recorded rather than closed. The operator has widened it. A
  bypass that needs no contract co-edit may _also_ be recorded as a documented residual
  when it lives in the **evaluation-semantics layer** — where what reaches an executor is
  the host language's own evaluation of a value it already holds, rather than any textual
  appearance of that value in the artifact a gate reads. There a repository-side gate has
  nothing to refuse: the shape is invisible at the layer the gate operates on, and closing
  it would mean reimplementing the language's evaluator inside a scanner this repository
  declares, in its first paragraph, is not one.

  The amended rule in full, as it now stands:

  1. A bypass that requires co-editing `contentus-pinned-repo-contract.json` in the same
     diff is a **documented residual**.
  2. A bypass that needs no contract co-edit but lives in the evaluation-semantics layer
     is a **documented residual**, provided it is recorded here with its shape, its
     execution semantics and its severity, in enough detail that a reviewer can
     reconstruct it from the text.
  3. Every other bypass — anything expressible as an appearance, a path, a digest, a
     content hash or an exact invocation — remains a **defect** and is closed
     deterministically. Widening the residual category does not widen it here, and no
     control added in rounds 1–7 is relaxed by this amendment.

  In both residual cases the compensating control is the same, and it is mandatory:
  **cross-client adversarial review of every `.github/` diff**, performed by a client that
  did not implement the change. That control was already load-bearing for case 1. For case
  2 it is the _only_ control, so relaxing the review requirement would not weaken these
  limits — it would remove them.

- **The executable closure has a declared boundary.** CON-5 hashes every `node <path>`
  target of a guarded command, every file its glob arguments expand to, and every
  relative module those files import, transitively. Two roots are outside it by
  declaration: `src/`, because it is the application the probes are written _against_ and
  hashing the subject would invert the relationship the gate exists to express, and
  `build/`, because it is regenerated every run and is asserted by COM-1 and driven by
  SEC-6 instead. A gate that imported helper logic out of either root would be unbound at
  that edge; none currently does, and the closure output printed in `CON-5-output.log`
  lists exactly what is covered. The walk follows static relative specifiers, so a gate
  that resolved a module path at runtime would also be outside it.
- **Tool provenance now binds the executed code, not just the tarball.** The previous
  form of this limit claimed that replacing the unpacked binary required a compromised
  runner. It did not: `install-greater-cli.mjs` is an ordinary repository file, and a
  pull request that appends a post-install write to it substitutes the executable while
  the contract, the workflow sentinel and the retained tarball all stay untouched. That
  is a bypass reachable without moving the pinned contract, so by the convergence rule
  below it was a defect rather than a limit, and it is closed deterministically: SEC-7
  validates the archive's members, extracts it into a fresh quarantine it creates and
  removes, compares every extracted file against the member it came from, and runs
  `--version` and `doctor` from that tree. Nothing under `gov-infra/.tools` is executed,
  and its absence is not even checked.

  Two residuals remain, both named rather than implied. The CLI's own runtime
  dependencies are resolved by `npm` from the registry against the ranges declared inside
  the verified archive; they are not repository artifacts and no pull request here can
  substitute them, but they are third-party code reached at gate time — the ordinary
  registry trust boundary, not something this control establishes. And a runner that
  modifies the extracted quarantine between extraction and execution is still outside
  repository-side control; unlike the case above, reaching it requires code execution on
  the runner rather than a diff.

- **The event-payload rule is an appearance rule now, and it supersedes position
  inference.** Refusing `${{ github.event.* }}` inside `run:` closed the direct spelling
  and left the indirection it recommends open: `env:` puts the value in the shell's
  environment, and a shell handed its own environment back as _program text_ is exactly
  as compromised as one that had the text spliced in. So SEC-3 also forbids an event
  expression in the `env:` of any reached composite action, and forbids splicing
  `${{ inputs.* }}` into a composite's `run:` — the `with:` channel is allowed because
  the value arrives as data, and interpolation makes it program text again.

  What the value may then do inside a `run:` was, for four rounds, decided by asking
  where in the shell it ended up. Each round proved its own claim and each claim was the
  wrong one. Naming the sink's head word left `env bash -c` open. Naming the resolved
  head word left fifteen shapes across quoting (`"bash" -c`), assignment, empty-expansion
  and redirection prefixes (`FOO=bar bash -c`, `$UNSET bash -c`, `> /dev/null bash <<<`),
  keyword compounds (`( bash -c … )`, `if true; then bash -c …; fi`) and a variable in
  command position (`VAR=bash; $VAR -c …`). Proving the command word of every parsed
  segment closed all fifteen — and left eleven more, because execution is not only in
  command position: `bash <(printf '%s' "$V")` hands a shell its script through a process
  substitution, `find . -exec bash -c "$V" \;` and `trap 'bash -c "$V"' EXIT` and
  `awk "$V" /dev/null` put program text in another command's argv, `exec 3<<EOF` shelves a
  heredoc onto a descriptor `bash <&3` then reads, `read`/`mapfile` launder the value into
  a fresh name, and a plain-scalar continuation line hides half the command from a scanner
  that reads physical lines. "Data position" is no more provable by grammar than "command
  position" was.

  **So the rule stopped asking. Event-derived data may APPEAR in a `run:` script in
  exactly two shapes, and every other appearance of it is a finding:**

  1. **argv to a script pinned by SHA-256** in `contentus-pinned-repo-contract.json`
     (`workflows.pinned_run_scripts`) — directly, or through an interpreter whose very
     next word is that script. The digest is verified against the file on disk before any
     allowance rests on it; a missing file, a symlink, or a content mismatch removes the
     script from the verified set and the appearance becomes an ordinary finding.
  2. **an argument to `printf` after a literal format** — `printf '%s' "$VALUE"`, which
     executes nothing. An expanded format is not the allowance, so `printf "$VALUE"` is a
     finding. `echo` is deliberately not an allowance: nothing here needs it, and a
     narrower allowance is the whole posture.

  Everything else is a finding without asking what the shell would do with it — `bash -c`,
  a `<(…)` operand, a `<<<` target, a heredoc body on any descriptor and under any
  quoting of its delimiter, a `read` or `mapfile` carrier, an assignment, a substitution
  interior, the argv of any command that is not one of those two. All eleven shapes above
  close by construction, and there is nothing left for a new spelling to be a new spelling
  _of_: to reach an executor a value must appear in the `run:` text, and appearing is what
  is refused.

  Three supports the rule still needs, each of them a place where "this scanner did not
  read it" would otherwise stand in for "this scanner cleared it".

  The parse must be right enough to recognise the two allowances, so a `run:` that cannot
  be lexed and parsed as shell — ANSI-C quoting, `|&`, an unbalanced group, an unterminated
  quote or heredoc, a redirection with no target — is a finding, as is a command word that
  is an expansion, and as is an inline `run:` value that is a quoted, aliased, anchored or
  tagged YAML scalar rather than shell text.

  The YAML layer must hand over the text GitHub's loader would produce: a folded (`>`)
  block is folded, and a plain scalar is joined with the more-indented lines that continue
  it, before anything is scanned. Both directions of that matter — unfolded, a legitimate
  folded `printf '%s'` / `"$VALUE"` was a false finding, and an appearance could hide on a
  continuation line the scanner never read.

  And the `run:` has to be shell at all. `shell: python` over
  `os.system(os.environ["PAYLOAD"])` carries no appearance a shell scanner can see, and
  the appearance rule read it as clean — the same failure one layer further out. So in a
  file that carries tainted data, a `shell:` naming anything but `bash` or `sh` is a
  finding, at a step or in `defaults:`, in flow form as well as block form. Neither of this
  repository's workflows declares a shell at all, and adding an interpreter is a governance
  edit rather than a step option.

  Over-blocking is bounded by the allowance rather than by a data/program line, and it is
  deliberately tighter than before: `env COPY="$TITLE" ./script.sh`,
  `env printf '%s' "$TITLE"` and `bash pinned.sh <<< "$TITLE"` were accepted under the sink
  rules and are findings now. The negative controls are the two allowances in every
  spelling the real workflows use, plus ordinary CI shell — `if`, `for`, `case`,
  `while read`, arrays, traps, arithmetic, a `cat` heredoc into a file — which is untouched
  because none of it carries the tainted name, and a file with no event-derived `env:` is
  not scanned at all.

  Both workflows that carry event data were migrated to satisfy the rule by construction
  rather than exempted from it. `dco.yml` passes `BASE_SHA`/`HEAD_SHA` to
  `scripts/dco-check.mjs`, which runs `git log` through an argument vector; `main-guard.yml`
  passes its four refs to `scripts/main-guard-check.mjs`. Both scripts are pinned by
  SHA-256, so `main-guard`'s three comparisons are now bound by content instead of matched
  as command text, while MAI-4 still binds the exact invocation in the workflow. Moving
  either script's behaviour therefore requires co-editing the pinned contract in the same
  diff — the documented-limit side of the convergence rule below, not the defect side.

  **Residuals of the appearance rule.** Six, recorded by shape, because the rule's whole
  claim is that nothing is left unexamined and a residual nobody wrote down is
  indistinguishable from one that was missed. A heredoc body written into `$GITHUB_ENV` is
  no longer among them — under the appearance rule the value in that body is a finding
  where it is written. The first three are limits of static analysis over `run:` text. The
  last three were surfaced by round-7 cross-client review, survived the stop rule, and are
  accepted under case 2 of the amended convergence rule above by the operator's 2026-07-31
  ruling. Every one of the six lands as `run:` text in a `.github/` diff, which is the
  review's subject, and none is expressible without it.

  1. **Inside the pinned script.** A value that reaches an executor within the pinned
     script itself. The SHA-256 binds what the script _is_, byte for byte; it does not
     model what the script does with its argv. _Low_ — moving that behaviour requires
     co-editing the pinned contract in the same diff, which is case 1.

  2. **The output of an allowed command, by any carrier.** `printf '%s' "$PAYLOAD"` is
     allowed because printf executes nothing; where its _output_ then goes is not
     followed. A pipe is one carrier of this and not the class — the same residual is
     reached by `printf '%s' "$PAYLOAD" | bash`, by
     `printf '%s' "$PAYLOAD" > payload.sh` with `bash payload.sh` after it, and by
     `printf '%s' "$PAYLOAD" >> "$GITHUB_PATH"`, which prepends an attacker-named
     directory to `PATH` for every later step in the job. In each the appearance is inside
     the printf allowance and the carrier operand is a literal, so nothing tainted appears
     anywhere the rule looks. _Medium._ (Rounds 5–7 worded this entry as "a pipe". Round 8
     restated it as the class it always was; the wording changed, the residual did not.)

  3. **`${!VAR}` indirect expansion.** Deliberately not matched as a reference, because
     matching it would make every `$`-sigil name a possible alias for every other. _Low._

  4. **Bare-name arithmetic recursive evaluation.** _High._

     _Shapes._ `X=$((PAYLOAD + 1))`; `let "X = PAYLOAD + 1"`; `declare -i X=PAYLOAD+1`;
     and the same expansion handed to a pinned script as argv,
     `node scripts/dco-check.mjs "$((PAYLOAD+1))"`.

     _Execution semantics._ In an arithmetic context bash resolves a bare name to the
     variable's value and then evaluates that value **as an arithmetic expression**,
     recursively. An array subscript is itself an arithmetic context, so a payload of
     `a[$(id >&2)]` reaches the command substitution inside it and executes it. None of
     this requires the value to be spelled `$PAYLOAD` anywhere. Confirmed by kimi against
     bash 5.2, and by factory with the array-subscript vector.

     _Why the whitelist sees no appearance._ An appearance is recognised by a `$` sigil
     followed by the name — `$NAME`, `${NAME}`. In arithmetic context the reference is the
     bare word `PAYLOAD`, so no appearance is found, including inside the arithmetic spans
     the substitution walk already visits, which look for that same sigil. In the
     pinned-script argv case the word sits inside the allowance in any event: bash
     performs the arithmetic expansion _before_ the script is executed, so the pin binds
     what the script receives and not what the shell did to produce it.

     _Why no contract co-edit is needed._ None of these shapes touches
     `contentus-pinned-repo-contract.json`, or any pinned digest, path or invocation. Each
     is ordinary `run:` text.

     _Why it is accepted._ Case 2 of the amended rule. Closing it deterministically would
     mean modelling bash's arithmetic evaluator — every context that evaluates a bare name
     (`$(( ))`, `let`, `declare -i`, an array subscript, `[[ … -eq … ]]`) and its recursion
     into the value — inside a scanner declared from its first paragraph not to be a Bash
     interpreter. Severity is high because it executes attacker-authored payload with no
     textual appearance for any appearance rule to refuse.

     _Compensating control._ Mandatory cross-client adversarial review of every `.github/`
     diff.

  5. **`printf` option surfaces.** _Medium._

     _Shape._ `printf -v PROG '%s' "$PAYLOAD"`, then `bash -c "$PROG"` after it.

     _Execution semantics._ The printf allowance models one data shape —
     `printf <literal-format> <arguments>`, which writes to stdout and executes nothing.
     It does not model printf's _options_. `-v NAME` sends the formatted result into the
     shell variable NAME instead of stdout, laundering the value into a name the allowance
     never examined. Two things then compose: the allowance accepts `-v` as the format
     word, so `$PAYLOAD` sits inside allowed argv; and taint propagation learns new names
     only from `NAME=` assignment tokens, so `PROG` never joins the tainted set and its
     later use is not an appearance at all.

     _Why no contract co-edit is needed._ Ordinary `run:` text; no pin moves.

     _Why it is accepted._ Case 2. The allowance is a claim about a data _shape_, and a
     builtin's option set is evaluation semantics rather than shape: `printf -v` is one
     member of a class — any builtin whose options change where its result lands — that a
     shape-level allowance cannot enumerate closed. Severity medium: it needs two visible
     commands in the same diff.

     _Compensating control._ Mandatory cross-client adversarial review of every `.github/`
     diff.

  6. **Computed-key `$GITHUB_ENV` and write-file laundering.** _Medium._

     _Shape._ `printf '%s=%s' MODE "$PAYLOAD" >> "$GITHUB_ENV"` in one step, then
     `bash -c "$MODE"` in a later step of the same workflow.

     _Execution semantics._ Taint propagation follows `$GITHUB_ENV` writes by reading a
     `NAME=` prefix off a token, so the literal-key spelling is caught: in
     `printf 'MODE=%s' "$PAYLOAD" >> "$GITHUB_ENV"` the token `MODE=%s` yields the name
     `MODE`, and `MODE` is tainted for every later step in the file. When the key arrives
     as its own argv word and the `=` comes from the format string, no token carries a
     `NAME=` prefix, no name is learned, and `MODE` is untainted everywhere downstream.
     The same holds for any spelling that computes the key rather than writing it
     literally.

     _Why no contract co-edit is needed._ Ordinary `run:` text; no pin moves.

     _Why it is accepted._ Case 2. Recovering the key would mean evaluating printf's
     format against its arguments — running the formatter rather than reading the text.
     Severity medium, for the same reason as the entry above.

     _Compensating control._ Mandatory cross-client adversarial review of every `.github/`
     diff.

  Install-invocation pinning still reads the older flat segmentation, which is strictly
  more suspicious than the parse — a grammar prefix makes an install fail to match its
  pinned text rather than hide it — so it is left as it is.

- **Composite evidence is separate evidence.** A run against another tree writes to its
  own directory under `gov-infra/evidence/`, so it neither deletes nor overwrites the
  logs belonging to this ref, and every `evidencePath` in a committed report resolves to
  a log committed beside it. The two reports remain two claims about two trees; neither
  is evidence for the other.
- **Install verification is not in this rubric.** A green report says the repository's
  gates passed at a ref. It says nothing about whether the app installs into, or renders
  correctly on, any lesser instance. That evidence comes from
  `install-contentus-instance` against a named instance at a named build.
