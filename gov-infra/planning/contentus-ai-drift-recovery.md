# AI/Agent Drift Recovery — contentus

Never make a report green by excluding code, lowering a gate, omitting a check, deleting
a test, or accepting floating Actions. Re-run the verifier, repair the failed control,
update the controls matrix and evidence plan, and retain fresh evidence.

Two contentus-specific drift shapes to recognize, because both look like fixes:

- **Silencing `greater doctor` by installing the Markdown chain.** That trades a checker
  warning for a second canonical renderer and breaks the invariant this client exists to
  hold. The disclosed finding stays disclosed until upstream changes.
- **Widening a disclosed-findings pin to absorb a new finding.** The pins in
  `contentus-disclosed-upstream-findings.json` are exact by design. A new advisory or a
  new doctor failure is a finding to route, not an entry to append. Appending is only
  correct once the finding has been examined, judged unfixable from the consumer side,
  and given an owner and a sunset.

Namespace MCP guidance does not replace repo-local CI; signing is retired.
