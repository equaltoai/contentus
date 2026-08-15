# Exercise — share, connect, observe, revoke

The M2 exit gate (equaltoai/contentus#96), as a procedure an operator or their
agent can re-run against a live instance.

M2.1–M2.4 each ship a surface that can pass in isolation while the path a human
actually walks stays broken — which is exactly what happened in M7. This
procedure is the whole path in one sequence, and it closes on nothing less:

1. an owner shares an agent with a second account,
2. that account signs in **as themselves**, finds the agent's MCP endpoint in
   the UI, and connects to it,
3. the grantee drives the agent,
4. the owner sees both the grant and the resulting activity attributed to that
   grantee,
5. the owner revokes, and the grantee's access fails closed.

## What the harness is, and what it is not

`scripts/probe-share-flow.mjs` is the machine-checkable part of the sequence
above. It follows this repository's one existing pattern for live-instance work
— `scripts/probe-live-contract.mjs` paired with `tests/live-probe.test.mjs`: an
operator-run script that takes its instance and its credentials as parameters,
exports `main()` so every direction can be driven through an injected `fetch` in
`node --test`, and never runs in CI against anything real.

It is **not** an automated end-to-end browser test, and that is a deliberate
choice rather than a missing one. Two of this flow's steps cannot be performed
by a script on the operator's behalf:

- **minting an MCP credential**, which runs through the grantee's browser
  against lesser's `auth-ui` — contentus neither performs that flow nor holds
  its output;
- **the UI reading itself**, which is what steps 1, 2 and 4 are actually about.
  A script that drove lesser's REST and GraphQL surfaces directly would prove
  the contracts answer and would say nothing about whether an operator can find
  the endpoint on screen.

So the shape is: **the operator walks the UI, and the harness independently
checks every claim the UI is making.** The harness marks its own output `PASS`
for what it checked and `ATTEST` for what it did not, counts the two separately,
and names each unproven claim in its summary. An ATTEST line is not a pass.

## Prerequisites

- A live lesser instance with `AllowAgents` on and the M1 share surface
  (`equaltoai/lesser#1397`) deployed.
- Two accounts on that instance. One (**the owner**) owns at least one agent;
  the other (**the grantee**) owns none of them.
- contentus installed on the instance — see `docs/runbook.md`.
- `node >= 24`.

Nothing else is registered anywhere. The instance, the agent and the grantee are
all supplied at invocation time, so running this against a second instance costs
three CLI values.

## Part A — the dry run (do this first)

The probe sends nothing unless told to. Start here every time, including after a
lesser upgrade: it prints the ordered plan, names the credential each step uses,
and tells you which steps this run would leave to your own record.

```bash
node --experimental-strip-types scripts/probe-share-flow.mjs \
  --base https://<instance> \
  --agent <agent-username> \
  --grantee <account-username>
```

Read the plan before you read anything else. It is the same list the summary
draws on at the end, so a step that is missing here is a step nothing will
report on later.

## Part B — the operator's walkthrough

Perform these in the browser, in this order. This is the sequence the 2026-08-14
verification followed.

### B1. The owner shares the agent

1. Sign in as the **owner** and go to `/agents`.
2. In **Agents you own**, find the agent. Its **`Sharing @<agent>`** panel is
   the M2.2/M2.3 surface — it appears only for agents lesser reports you own.
3. Enter the grantee's username in **Local account to grant** and press
   **Grant access**.
4. The account appears under **Who has access now**, stamped with when it was
   granted and by whom.

Do this for a **second agent** as well, shared with the same account. One agent
proves a grant; two prove the grantee's list is a list, and that the endpoint
each one publishes is its own.

### B2. The grantee finds the endpoint

1. Sign out. Sign in as the **grantee** — as themselves, not as the agent and
   not through any act-as control. There is no such control: M2.1 removed it,
   and its absence is part of what this step verifies.
2. Go to `/agents`. The **Agents shared with you** panel lists both agents, each
   with its own **MCP endpoint**.
3. Copy each endpoint. It is lesser's `mcpAccess.mcpURL` verbatim — contentus
   assembles no part of it, so what is on screen is what the instance published.

If a row says _"This instance publishes no MCP endpoint for this agent"_, that
is the instance stating it publishes none, not a failure to load. Stop and route
that upstream rather than working around it.

For the full connection bundle — authorization server, registration endpoint,
scopes, and copy-paste client configs — open `/agents/<agent-username>`.

### B3. The grantee connects and drives

For **each** shared agent, from the grantee's own MCP client:

1. Authorize against the instance using the endpoint as the RFC 8707 `resource`.
   The authorization server is discoverable from the protected-resource document
   the endpoint publishes; `/agents/<agent-username>` shows both.
2. Connect and confirm the session is live (`initialize`, `tools/list`).
3. **Drive the agent** — perform an action lesser records, not just a read. The
   activity log keeps only `agent.`-prefixed events, so listing tools writes no
   row and will not appear in step B4.

### B4. The owner observes

Back as the **owner**, on `/agents`:

1. **`Sharing @<agent>`** still shows the grantee under **Who has access now**.
2. **`Who has been driving @<agent>`** — the M2.4 surface — names the grantee
   under **Drivers**, with the mechanism lesser recorded, and the action itself
   under **Recent actions**.

The driver name comes from lesser's audit metadata (`delegated_by`, `acted_by`).
contentus does not infer it and cannot manufacture it.

### B5. The owner revokes, and access fails closed

1. Press **Revoke** beside the grantee under **Who has access now**.
2. The entry moves to **Access that was revoked** with a revocation stamp.
3. On the grantee's side: the live MCP session stops working immediately, and a
   fresh authorization attempt for that agent is refused.

Both halves matter. A grant that disappears from a list while the credential
keeps working is the failure this step exists to catch.

## Part C — the harness run

Run this against the same instance to check the same claims independently. It
performs a **write**: it grants the named account access and then revokes it.

```bash
CONTENTUS_OWNER_TOKEN=…   \
CONTENTUS_GRANTEE_TOKEN=… \
node --experimental-strip-types scripts/probe-share-flow.mjs \
  --base https://<instance> \
  --agent <agent-username> \
  --grantee <account-username> \
  --execute
```

Credentials are read from the environment only — never flags, which land in
shell history and process listings — and every byte the probe writes goes
through a redactor that knows all of them and asserts its own output is clean.

Supply `CONTENTUS_GRANTEE_MCP_TOKEN` as well — the token minted in B3 — and two
more steps become machine-checked: that the grantee's session is live, and that
the same credential is refused after revocation.

**A run carrying that token must first say which MCP host it may reach.** Take
the endpoint from the `Connect a client` panel in B2 — the host of the URL the
grantee is shown — and name it:

```bash
CONTENTUS_OWNER_TOKEN=… CONTENTUS_GRANTEE_TOKEN=… CONTENTUS_GRANTEE_MCP_TOKEN=… \
node --experimental-strip-types scripts/probe-share-flow.mjs \
  --base https://<instance> --agent <agent> --grantee <account> \
  --mcp-host <mcp-host> --execute
```

Without `--mcp-host` (or `--i-trust-the-published-host`, below) a run holding
that token **refuses to start** and sends nothing at all. The reason is in the
next section.

Run it **after** B3 so there is a recorded action for the attribution step to
find. The probe's own drive is `initialize` + `tools/list` and nothing else — it
proves the session without changing anything, which also means it writes no
audit row and cannot satisfy that step itself. Pass `--no-attribution` to run
before a recorded action exists; the summary then says, in as many words, that
the run did not check attribution.

### Three things it refuses to do

**It will not revoke access it did not create.** Before writing anything it
reads the owner's share list, and if the grantee already holds active access it
aborts having sent no write. The flow ends in a revocation, and revoking a
standing grant nobody asked it to remove is not a cost a milestone check may
impose. It aborts for the same reason when the instance sends a share entry it
did not mark active or revoked — that entry could be the grantee's.

That preflight is a **gate on starting, never the authority for the deletion**.
It is a read, and a dozen requests happen after it; you or another admin can
grant that same account access inside that window, in another browser tab, at
which point "the grantee held nothing when we looked" describes the past and a
revocation would land on a grant somebody meant to keep. So the deletion has its
own authority: the `granted_at`/`granted_by` stamp lesser returns for the row
**this run's own write produced**, captured at that moment and re-checked against
a fresh read of the share list taken immediately before the delete. A row that
moved underneath the run — re-granted, removed, re-stamped, or left unclassified
— stops the revocation with the grant intact and says so by name. The same
identity covers the other edge: if lesser answers the write with a row it says
somebody else granted, that is a standing grant this run merely adopted, and the
run aborts rather than adopting the right to remove it.

This applies to the **cleanup** too — the revocation that runs after a failure,
which is the one most likely to be written as an unconditional delete and the one
where that would do the most damage. If the cleanup cannot identify its own row it
refuses, and prints, loudly, that the access may still be standing and must be
revoked by hand. **A refusal here means you have a grant to remove from the
`Sharing @<agent>` panel before you leave the instance.**

What that does **not** do is abolish the window, and the procedure should not be
read as if it did. lesser's share routes expose no compare-and-delete — no
`If-Match`, no revocation conditional on the stamp the caller last read — so a gap
remains between the harness's final read and its delete, and a grant created
inside _that_ gap would still be removed. The change is one of size: from the
whole run, which is a dozen requests plus however long Part B takes, down to a
single round trip. Closing it completely is lesser's to give and belongs upstream
against `equaltoai/lesser`. In practice: **do not grant that account access to
that agent from another window while the harness is running.**

**It will not send the grantee's MCP credential to a host nobody vouched for.**
`mcpAccess.mcpURL` is a value the _server publishes_, and
`CONTENTUS_GRANTEE_MCP_TOKEN` is a working bearer for the grantee's account.
Handing the second to the first because the first arrived in a response trusts a
host on the word of the party that named it — an instance that is compromised,
misconfigured, or simply pointed at the wrong origin publishes a URL and receives
a credential. So the decision is yours and it is made up front:

- `--mcp-host <host>` — the host you expect. Checked against what the instance
  actually publishes **before the first request reaches that origin**; a mismatch
  is a failing step with nothing sent to it at all, credential or otherwise.
- `--i-trust-the-published-host` — accept whatever is published. It works, warns
  on its own line, and the endpoint check is counted among the claims the run did
  **not** establish.

The two are contradictory and passing both is refused: an escape hatch that
silently overrode a stated expectation would be the fail-open the pair exists to
prevent. Without the MCP token there is nothing of the grantee's to lose to that
host and the run proceeds either way — still saying which of the two it did.

**It will not accept two credentials for one account.** Sharing an agent with
yourself walks every route and demonstrates none of the flow.

### Reading the result

Exit 0 means every step the probe checked passed. It is not a statement about
the ATTEST steps, and the summary lists those by name. A run that exercised the
full flow with an MCP credential and `--mcp-host` supplied reports **19/19
checked** and **2 steps this run did not prove** — the credential mint and the
recorded action, both of which happen in B3 under the operator's own hand. Swap
`--mcp-host` for `--i-trust-the-published-host` and it is **18/18 checked** with
three unproven, the third being the published endpoint nobody vouched for.
Without the MCP credential at all: **16/16 checked**, five unproven.

## What is proven where

| Step                                       | B (UI) | C (harness)          |
| ------------------------------------------ | ------ | -------------------- |
| Owner grants access                        | ✔      | ✔                    |
| Owner's current-access list names grantee  | ✔      | ✔                    |
| Grantee's shared-with-me list names agent  | ✔      | ✔                    |
| Grantee reads the published MCP endpoint   | ✔      | ✔                    |
| Published endpoint is on the expected host | ✔      | ✔ with `--mcp-host`  |
| Endpoint's discovery documents answer      | —      | ✔                    |
| Endpoint refuses an unauthenticated caller | —      | ✔ (negative control) |
| Grantee mints an MCP credential            | ✔      | ATTEST — always      |
| Grantee's session is live                  | ✔      | ✔ with the MCP token |
| Grantee performs a recorded action         | ✔      | ATTEST — always      |
| Owner sees the grantee attributed          | ✔      | ✔                    |
| Owner revokes                              | ✔      | ✔ (own grant only)   |
| Both lists reflect the revocation          | ✔      | ✔                    |
| Revoked credential is refused              | ✔      | ✔ with the MCP token |

The negative control is the row that makes the rest mean anything: without
proving the endpoint refuses an anonymous caller, "the grantee connected" says
only that a URL answered.

## Demonstrated instance

**2026-08-14 — `theory.greater.website` (live), post-deploy of M2.1–M2.4.**
Walked by the operator, and the instance of this flow that closes
equaltoai/contentus#96:

- **Share** — two agents shared with the same second account from the owner's
  `Sharing @<agent>` panels.
- **Connect** — the grantee signed in as themselves, read **each** agent's MCP
  endpoint from the UI, and connected to both.
- **Drive** — the grantee drove each agent over its own MCP endpoint.
- **Observe** — the owner saw the grants in the sharing panels and the
  grantee's activity attributed in the driver view.
- **Revoke** — revocation took effect immediately: the grantee's live session
  disconnected and a re-login attempt was blocked.

That walkthrough is what Part B formalizes. Part A and Part C were built to make
it re-runnable rather than to re-prove it; the harness had not yet been written
when it was performed, so the evidence for that date is the operator's record of
the UI walkthrough, not a probe transcript.

## Re-running after a lesser upgrade

This is the procedure's real job. After the instance takes a new lesser:

1. **Part A**, unchanged. It sends nothing, so it costs nothing.
2. **Part C** against the upgraded instance. It reads the share routes, the
   `mcpAccess` field, the discovery documents and the activity log through the
   app's own documents and readers — `AGENT_MCP_ACCESS_QUERY`,
   `AGENT_ACTIVITY_QUERY`, `accessLedger`, `driverLedger` are imported from the
   shipped modules, never retyped — so a contract that moved under contentus
   shows up here as a named failing step rather than as a screen that renders
   emptily.

   **Run it without `CONTENTUS_GRANTEE_MCP_TOKEN` at this point in the order.**
   An upgrade is exactly when a published endpoint legitimately moves, so the
   `--mcp-host` you used last time is precisely the value you cannot trust yet —
   and reusing it stale is the one shape of this step that could offer a bearer to
   an endpoint no human has looked at since the upgrade. The harness enforces the
   floor (no host decision, no start; a mismatched host, no request), but the
   ordering is what keeps you from _making_ the wrong decision: read the endpoint
   off the screen in **B2** first, and only then re-run Part C with the MCP
   credential and the host you just read. Everything else in Part C needs no such
   ordering, which is why it comes first.

3. **Part B** for anything Part C marked ATTEST, plus a look at the two panels —
   and, per the note above, for the endpoint the credentialed re-run will pin.
4. **Part C again with the MCP credential**, if you want the drive and the
   post-revoke fail-closed check machine-checked rather than attested.
5. If a step fails because lesser changed, that is an upstream report against
   `equaltoai/lesser`, not a local patch. See `docs/consumption/agent-contract.md`
   for what this client already records about each of these surfaces.

`pnpm test` covers the harness itself — its refusals, its redaction, its
reporting — against an injected `fetch`, and needs no instance.
