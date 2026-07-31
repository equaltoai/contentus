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

| Threat ID | Title                         | What can go wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Primary controls                         | Verification                                                                                                                                                                               |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| THR-1     | Supply-chain compromise       | A mutable Action, a lifecycle hook, or an unlocked dependency executes in CI — including through a CI install that quietly drops `--ignore-scripts` before the rubric can object.                                                                                                                                                                                                                                                                                                                                                                                                                                              | SEC-3, COM-2                             | `check_supply_chain`, pinned install invocations                                                                                                                                           |
| THR-2     | Client regression             | SSR routes, types, Svelte components, or the two-pass build regress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | QUA-1, QUA-2, CON-2                      | build, tests, type checks                                                                                                                                                                  |
| THR-3     | Web-integrity regression      | Built output introduces inline scripts, styles, or event handlers, or a third-party script origin, breaking the strict CSP the FaceTheory host enforces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | SEC-4                                    | built-output CSP audit                                                                                                                                                                     |
| THR-4     | Governance drift              | The deterministic rubric or the pull-request CI hook disappears or goes stale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | MAI-4, DOC-5                             | CI-hook and threat/control parity checks                                                                                                                                                   |
| THR-5     | Renderer-authority violation  | A Markdown or HTML rendering path, a client-side excerpt/TOC generator, or a raw-draft-source display appears in the client, creating a second canonical renderer.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | SEC-5                                    | `pnpm run validate:renderer-authority`                                                                                                                                                     |
| THR-6     | SSR trust-boundary regression | The handler resolves its origin from an unverified `Host`, leaks withheld article source, or serves 200 for a CMS object that does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | SEC-6                                    | built-handler SSR probes                                                                                                                                                                   |
| THR-7     | Vendored-source drift         | A vendored greater-components file is hand-edited, an orphan appears under the vendored root, or the CLI-copy and tarball channels drift out of lockstep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | SEC-7, CON-4                             | `greater doctor`, pin-lockstep check                                                                                                                                                       |
| THR-8     | Disclosed-finding drift       | A known, unfixed upstream finding silently changes shape, or a new finding hides behind an old one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | SEC-2, SEC-7                             | exact-set assertion against the pinned disclosures                                                                                                                                         |
| THR-9     | Gate self-neutralization      | The change under review edits what the rubric trusts — a `package.json` script, the file a pinned command _executes_, a probe's assertions, the install manifest, a pin — so a control exits 0 without its property holding.                                                                                                                                                                                                                                                                                                                                                                                                   | CON-3, CON-4, CON-5, COM-1, SEC-6, SEC-7 | content hashes and shapes asserted against the pinned repo contract                                                                                                                        |
| THR-10    | Tool-provenance substitution  | The tool that produces a control's evidence is not the pinned tool. `greater` is not on the npm registry, so a PATH binary — or an unpacked tree an editable installer replaced after the digest check — prints the pinned version, emits a plausible `doctor` document, and satisfies the control while auditing nothing.                                                                                                                                                                                                                                                                                                     | SEC-7, MAI-4                             | the gate extracts and executes the digest-verified asset itself; unverifiable provenance is BLOCKED                                                                                        |
| THR-11    | Install-artifact escape       | A build artifact is a symlink rather than a file. Every lexical containment check still passes, and `lesser client install` follows the link on upload, packaging a file from the build host into the installed app.                                                                                                                                                                                                                                                                                                                                                                                                           | CON-3, COM-1                             | real-path containment and a symlink walk of the artifact directories                                                                                                                       |
| THR-12    | Event-payload execution in CI | Attacker-authored pull-request text reaches a shell or interpreter in a workflow or a reached composite action. Refusing `${{ github.event.* }}` inside `run:` closes only the direct spelling; the `env:` indirection it recommends is a second path when the value is consumed as program text rather than as data; and any rule that names the sink by how it is _spelled_ — the word a segment starts with, or the word it starts with once wrappers are stripped — is beaten by shell grammar, which can put the same interpreter behind quoting, an assignment or redirection prefix, a keyword compound, or a variable. | SEC-3, MAI-4                             | event-expression scan, composite `env:` prohibition, and an executable-sink analysis that must _resolve_ every command word of a parsed `run:` to a literal and reports whatever it cannot |

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

- **The event-payload rule reaches the sink, and the analysis reads `run:` text.**
  Refusing `${{ github.event.* }}` inside `run:` closed the direct spelling and left the
  indirection it recommends open: `env:` puts the value in the shell's environment, and a
  shell handed its own environment back as _program text_ is exactly as compromised as
  one that had the text spliced in. So SEC-3 now also forbids an event expression in the
  `env:` of any reached composite action, forbids splicing `${{ inputs.* }}` into a
  composite's `run:` — the `with:` channel is allowed because the value arrives as data,
  and interpolation makes it program text again — and rejects an event-derived or
  caller-supplied env value that reaches an executable sink: `bash`/`sh -c`, `eval`,
  `node -e`, `python -c` and their siblings, `source`/`.`, an interpreter handed its
  program on standard input, a command or process substitution, or the command word of a
  segment. Taint follows shell assignment and same-line `$GITHUB_ENV` writes to a
  fixpoint, so renaming a value does not launder it, and a substitution is judged by
  these same rules rather than by the mere appearance of the name — `$(printf '%s'
"$TITLE")` consumes data, `$(bash -c "$TITLE")` does not.

  A sink is identified by what a segment _executes_, not by the word it starts with —
  and, since three successive rounds of this rule each fell to a spelling it had not
  enumerated, not by spelling at all. Naming the head word left `env bash -c` and
  stdin-fed programs open; naming the resolved head word still left fifteen shapes in six
  families, every one of which runs in bash: quoting and backslashes rewrite the
  executing word (`"bash" -c`, `b\ash -c`), assignment, empty-expansion and redirection
  prefixes move it off the front (`FOO=bar bash -c`, `$UNSET bash -c`, `> /dev/null bash
<<<`), `!`, subshells and keyword compounds put it after a grammar token (`( bash -c … )`,
  `if true; then bash -c …; fi`), and a variable can be the executing word itself
  (`VAR=bash; $VAR -c …`). Enumeration does not beat a grammar.

  So the standard of proof is inverted. **The scanner must prove a segment safe, and a
  segment it cannot resolve is a finding.** Every `run:` in a file that carries tainted
  data is lexed and parsed as shell — quote and backslash removal, expansions, process
  substitutions, comments, fd-prefixed redirections, heredocs, pipelines, lists,
  subshells, groups, `!`, and the `if`/`while`/`until`/`for`/`case` compounds — and each
  simple command that falls out has its assignment prefixes and redirections stripped
  before its command word is read. That word must resolve to a **literal**: an expansion
  or substitution in command position names nothing this scanner can read, so it is a
  finding on its own, which closes `$UNSET bash -c` and `$VAR -c` structurally and with
  no tracking of what a variable might hold. Text the grammar cannot parse — `$'…'`
  quoting, `|&`, an unbalanced group, an unterminated quote or heredoc, a redirection
  with no target — is a finding for the same reason, as is an inline `run:` value that is
  a quoted, aliased, anchored or tagged YAML scalar rather than shell text this scanner
  can read. Refusing to decode a second notation in passing is the same lesson applied
  one layer up.

  Over-blocking is bounded by the same data/program line as before, and the negative
  controls are the proof: `env VAR=value ./script.sh`, `env COPY="$TITLE" ./script.sh`,
  `env printf '%s' "$TITLE"`, argv to a pinned script, `bash pinned.sh <<< "$TITLE"` —
  where the operand names the script that owns stdin — `if`, `for` and `case` in ordinary
  CI shell, and both of this repository's real workflows all stay accepted.

  What it does not follow, because a `run:`-text scanner cannot: a value that reaches an
  executor inside a script the workflow calls, a value carried across a pipe into an
  interpreter in another segment, `${!VAR}` indirect expansion, and a heredoc written
  into `$GITHUB_ENV`. Those four are unchanged by the parse; the parse does newly read a
  heredoc body as an interpreter's program text, whether or not the delimiter is quoted.
  Quoting the delimiter stops the _outer_ shell expanding the body as it writes it, and
  an interpreter handed that body as its program expands it itself — `bash <<'EOF'` over
  a line reading `$PAYLOAD` runs the payload, confirmed in bash — so the quotes buy
  nothing at a sink. They buy the whole difference at a data use, which is why
  `cat <<'EOF' >> "$GITHUB_ENV"` is untouched: `cat` executes nothing, and following
  taint back out of that heredoc remains the residual it always was. The four are limits
  of static
  analysis over shell rather than unguarded shapes: each would land as `run:` text in a
  `.github/` diff, which is the review's subject, and none is expressible without it.
  They are recorded here under the convergence rule below rather than implied to be
  covered. Install-invocation pinning still reads the older flat segmentation, which is
  strictly more suspicious than the parse — a grammar prefix makes an install fail to
  match its pinned text rather than hide it — so it is left as it is.

- **Composite evidence is separate evidence.** A run against another tree writes to its
  own directory under `gov-infra/evidence/`, so it neither deletes nor overwrites the
  logs belonging to this ref, and every `evidencePath` in a committed report resolves to
  a log committed beside it. The two reports remain two claims about two trees; neither
  is evidence for the other.
- **Install verification is not in this rubric.** A green report says the repository's
  gates passed at a ref. It says nothing about whether the app installs into, or renders
  correctly on, any lesser instance. That evidence comes from
  `install-contentus-instance` against a named instance at a named build.
