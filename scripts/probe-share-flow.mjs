#!/usr/bin/env node
/**
 * END-TO-END SHARE FLOW PROBE — share → connect → observe → revoke, against a
 * real lesser instance (M2.5, equaltoai/contentus#96).
 *
 * WHY THIS EXISTS. M2.1-M2.4 each ship a surface that passes in isolation, and
 * M7 is the standing proof that every part can be green while the operator-facing
 * path is broken. The milestone's exit gate is the WHOLE path, so this probe
 * walks it as one sequence against one instance under two real accounts, and
 * reports which of its claims it actually established.
 *
 *   # the default: print the plan, send nothing
 *   node --experimental-strip-types scripts/probe-share-flow.mjs \
 *     --base https://<instance> --agent <agent-username> --grantee <account>
 *
 *   # the operator's run
 *   CONTENTUS_OWNER_TOKEN=… CONTENTUS_GRANTEE_TOKEN=… \
 *     node --experimental-strip-types scripts/probe-share-flow.mjs \
 *     --base https://<instance> --agent <agent-username> --grantee <account> --execute
 *
 *   # with the grantee's MCP credential, which requires naming the host it may
 *   # reach — see THE MCP CREDENTIAL GOES TO A HOST THE OPERATOR NAMED below
 *   CONTENTUS_OWNER_TOKEN=… CONTENTUS_GRANTEE_TOKEN=… CONTENTUS_GRANTEE_MCP_TOKEN=… \
 *     node --experimental-strip-types scripts/probe-share-flow.mjs \
 *     --base https://<instance> --agent <agent-username> --grantee <account> \
 *     --mcp-host <mcp-host> --execute
 *
 * ── IT SENDS NOTHING UNLESS IT IS TOLD TO ───────────────────────────────────
 *
 * Two of this flow's steps are WRITES — `PUT` and `DELETE` on lesser's share
 * routes — so a probe that ran on invocation would mutate an instance's access
 * grants because somebody was reading the help. `--execute` is required, and
 * without it not one request leaves: the run prints the ordered plan, names the
 * credential each step uses (never its value), and exits. `tests/share-flow-
 * probe.test.mjs` drives a dry run against a `fetch` that throws if called.
 *
 * ── IT REFUSES TO REVOKE ACCESS NOBODY ASKED IT TO REMOVE ───────────────────
 *
 * The flow ends by revoking, which is only safe because the grant being revoked
 * is the one this run created. So before anything is written the probe reads the
 * owner's share list, and if the grantee ALREADY holds active access it aborts
 * without writing: continuing would end by deleting a standing grant the operator
 * never mentioned, and "the probe passed" is not worth someone's access.
 *
 * It also refuses when the two credentials resolve to the SAME identity. Sharing
 * an agent with yourself walks every route and demonstrates none of the flow.
 *
 * THE PREFLIGHT IS A READ, AND A READ IS A MOMENT. Between it and the revocation
 * at the end of the run sit a dozen requests, and an owner or an admin in another
 * window can grant that same account access inside that window — at which point
 * "the grantee held nothing when we looked" is a statement about the past and the
 * DELETE at the end lands on a grant somebody meant to stand (codex review
 * 4942154730 on equaltoai/contentus#102). So the preflight is a gate on starting,
 * never the authority for the revocation. The revocation's own authority is an
 * IDENTITY: the `granted_at`/`granted_by` stamp lesser returned for the row this
 * run's `PUT` produced, captured at the moment it was produced, checked against a
 * FRESH read of the share list immediately before the DELETE. A row that moved
 * under this run is a row this run did not create, and the probe aborts loudly
 * with the grant left standing rather than revoking blind — including in the
 * cleanup path, which is the one that runs when everything else has already
 * failed. Every DELETE this file can send goes through `revokeOwnGrant`; there is
 * no second spelling of the revocation for that guarantee to miss.
 *
 * The same identity closes the window on the other side. lesser stores ONE ROW
 * PER GRANTEE, so a grant landing between the preflight and this run's own `PUT`
 * is re-granted rather than duplicated — and the `PUT` response names who granted
 * it. If that is not the account this run authenticated as, the row predates this
 * run and this run will not remove it.
 *
 * WHAT IS LEFT, SAID PLAINLY. This NARROWS the window; it does not abolish it.
 * lesser's share routes expose no compare-and-delete — no If-Match, no revocation
 * conditional on the stamp the caller last read — so between this file's final
 * read and its `DELETE` there remains a gap no client-side check can close, and a
 * grant created inside THAT gap would still be removed. What changed is the size:
 * from the whole run, which is a dozen requests and however long a human spends
 * in Part B, down to one round trip. Closing it entirely is lesser's to give and
 * an upstream ask against `equaltoai/lesser`, not something this probe may claim
 * by asserting harder — a guarantee stated past its evidence is the defect, not
 * the remedy for one.
 *
 * ── WHAT IT PROVES, AND WHAT IT ONLY WATCHES ────────────────────────────────
 *
 * Marks are `PASS`/`FAIL` for what this process checked and `ATTEST` for what it
 * did not. An ATTEST step is NOT a pass — it is a claim left to the operator's
 * own record — and the summary counts them separately and names each one, because
 * an omitted gate reads as a passed gate to anyone skimming.
 *
 * The step that is only ever the operator's is MINTING AN MCP CREDENTIAL. That
 * runs through the grantee's browser against lesser's `auth-ui`, and contentus
 * neither performs nor holds it. Supply the resulting token as
 * `CONTENTUS_GRANTEE_MCP_TOKEN` and the drive and the post-revoke fail-closed
 * check become machine-checked; omit it and they are ATTEST.
 *
 * THE DRIVE THIS PROBE PERFORMS IS `initialize` + `tools/list` AND NOTHING ELSE.
 * That proves the session is live without changing anything on the instance. It
 * is deliberately NOT enough to satisfy the attribution step: lesser's activity
 * log keeps only `agent.`-prefixed events, so a read-only session writes no row.
 * Attribution is checked against a recorded action the operator performs — see
 * `docs/exercise/end-to-end-share-connect-observe.md`.
 *
 * ── THE MCP CREDENTIAL GOES TO A HOST THE OPERATOR NAMED ────────────────────
 *
 * `mcpAccess.mcpURL` is a value THE SERVER PUBLISHES, and `CONTENTUS_GRANTEE_MCP_
 * TOKEN` is a bearer for the grantee's account. Sending the second to the first
 * because the first arrived in a response is trusting a host on the word of the
 * party that named it: an instance that is compromised, misconfigured, or simply
 * pointed at the wrong origin publishes a URL, and the probe hands it a working
 * credential (codex review 4942154730 on equaltoai/contentus#102).
 *
 * So the token cannot leave for a host nobody vouched for. With the token set the
 * run REFUSES TO START unless the operator has either named the host they expect
 * (`--mcp-host <host>`) or accepted whatever is published, in as many words
 * (`--i-trust-the-published-host`). Naming it is checked against what the instance
 * actually publishes BEFORE the first request reaches that origin — a mismatch is
 * a failed step with nothing sent to it, credential or otherwise. Accepting it is
 * an ATTEST, warned about on its own line, and counted among the claims the run
 * did not establish. Without the token there is no credential to lose and the run
 * proceeds either way, still saying which of the two it did.
 *
 * ── THE DOCUMENTS AND THE READERS ARE THE APP'S ─────────────────────────────
 *
 * `AGENT_MCP_ACCESS_QUERY`, `AGENT_ACTIVITY_QUERY`, `accessLedger` and
 * `driverLedger` are IMPORTED from the shipped modules, never retyped. A probe
 * carrying its own copy of the query or its own idea of what "the grantee drove
 * it" looks like is a fixture written to agree with itself — the defect this
 * repository has already paid for twice. Attribution in particular is matched
 * through `driverLabel`/`driverKey` rather than by string equality, because
 * lesser writes the same human as `@Alice` on a delegated row and `alice` on an
 * act-as row and a probe comparing strings would miss half the evidence.
 *
 * Transport is the probe's own, like `probe-live-contract.mjs`: an explicit base,
 * explicit bearers, and a writer that cannot emit a credential.
 *
 * ── THE CREDENTIALS NEVER LEAVE ─────────────────────────────────────────────
 *
 * All three are read from the environment only — never flags, which land in shell
 * history and process listings — and EVERY byte written goes through a redactor
 * that knows all of them and then asserts its own output is clean. The single-token
 * `redacting` in `probe-live-contract.mjs` is not reused because it takes one
 * secret and this run holds three; sharing it would mean widening a pinned gate
 * file for no gain here.
 */
import { AGENT_ACTIVITY_QUERY } from '../src/lib/agents/activity-client.ts';
import { driverKey, driverLabel, driverLedger } from '../src/lib/agents/activity-view.ts';
import { AGENT_MCP_ACCESS_QUERY } from '../src/lib/agents/contract.ts';
import { accessLedger } from '../src/lib/agents/share-view.ts';

const GRAPHQL_PATH = '/api/graphql';
const AGENTS_PATH = '/api/v1/agents';

/**
 * The protected identity read, spelled here for the same reason
 * `probe-live-contract.mjs` spells its own: it is not a document the application
 * sends, it is the probe asking lesser who each credential belongs to.
 * `tests/share-flow-probe.test.mjs` validates it against the pinned lesser
 * schema, which is a stronger control than importing would be — importing proves
 * two files in this repository agree, validating proves lesser would accept it.
 */
export const VIEWER_IDENTITY_QUERY = `
query ContentusShareFlowViewerIdentity {
	viewer {
		id
		username
	}
}
`;

/* -------------------------------------------------------------------------
 * A writer that cannot emit any of the credentials
 * ---------------------------------------------------------------------- */

/**
 * Redact every spelling of every supplied secret, then CHECK the result.
 *
 * A redactor that silently missed an encoding is worse than none, because its
 * output carries the reassurance of having been redacted. Longest-first so a
 * secret that contains another is removed whole rather than leaving a tail.
 */
export function redactingAll(write, tokens) {
	const spellings = [
		...new Set(
			(tokens ?? [])
				.filter((token) => typeof token === 'string' && token !== '')
				.flatMap((token) => [
					token,
					encodeURIComponent(token),
					Buffer.from(token).toString('base64'),
				])
		),
	]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);

	const secrets = (tokens ?? []).filter((token) => typeof token === 'string' && token !== '');

	return (text) => {
		let out = String(text);
		for (const spelling of spellings) out = out.split(spelling).join('«redacted»');
		if (secrets.some((secret) => out.includes(secret))) {
			// Never print the offending text — not even to explain itself.
			process.stderr.write(
				'\nprobe-share-flow: ABORTING — output still contained a credential after redaction. ' +
					'This is a bug in the redactor, and printing anything further would leak it.\n'
			);
			process.exit(2);
		}
		write(out);
	};
}

/* -------------------------------------------------------------------------
 * Arguments
 * ---------------------------------------------------------------------- */

function flagValue(argv, name) {
	const index = argv.indexOf(name);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

/** A nonempty string, which is what "a value" means throughout this file. */
const value = (raw) => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null);

/**
 * The operator's `--mcp-host` as a `URL.host` looks, or null when it is not one.
 *
 * A HOST, NEVER A URL. `https://api.example/mcp/scribe` parses perfectly well and
 * would compare equal on its host while quietly discarding the path the operator
 * typed — and the whole point of the flag is that the operator said exactly what
 * they meant. Anything carrying a path, a query or a fragment is refused by name
 * rather than trimmed into something that passes.
 */
export function expectedHost(raw) {
	const supplied = value(raw);
	if (!supplied) return null;
	let url;
	try {
		url = new URL(supplied.includes('://') ? supplied : `https://${supplied}`);
	} catch {
		return null;
	}
	if (url.pathname !== '/' || url.search || url.hash || !url.host) return null;
	return url.host.toLowerCase();
}

export function readOptions(argv, env) {
	const problems = [];

	const rawBase = flagValue(argv, '--base');
	let base = null;
	if (!rawBase) {
		problems.push('--base <https://instance> is required');
	} else {
		let url = null;
		try {
			url = new URL(rawBase);
		} catch {
			problems.push(`--base ${rawBase} is not a URL`);
		}
		if (url && url.protocol !== 'https:') {
			// Three bearer tokens travel over this; none may leave over plaintext.
			problems.push('only https bases are accepted');
		} else if (url) {
			base = url.origin;
		}
	}

	const agent = value(flagValue(argv, '--agent'));
	if (!agent) problems.push('--agent <agent-username> is required');

	const grantee = value(flagValue(argv, '--grantee'));
	if (!grantee) problems.push('--grantee <account-username> is required');

	const execute = argv.includes('--execute');
	const attribution = !argv.includes('--no-attribution');

	const ownerToken = value(env.CONTENTUS_OWNER_TOKEN);
	const granteeToken = value(env.CONTENTUS_GRANTEE_TOKEN);
	const granteeMcpToken = value(env.CONTENTUS_GRANTEE_MCP_TOKEN);

	if (execute && !ownerToken) problems.push('CONTENTUS_OWNER_TOKEN must be set for --execute');
	if (execute && !granteeToken) problems.push('CONTENTUS_GRANTEE_TOKEN must be set for --execute');

	const rawMcpHost = flagValue(argv, '--mcp-host');
	const mcpHost = expectedHost(rawMcpHost);
	const trustPublishedHost = argv.includes('--i-trust-the-published-host');
	if (value(rawMcpHost) && !mcpHost) {
		problems.push(
			`--mcp-host ${rawMcpHost} is not a host — pass api.example.com or api.example.com:8443, ` +
				'not a URL with a path'
		);
	}
	if (mcpHost && trustPublishedHost) {
		// One says "it must be this host", the other says "whatever it is". Picking
		// a winner would mean an escape hatch silently overriding a stated
		// expectation, which is the fail-open this pair exists to prevent.
		problems.push(
			'--mcp-host and --i-trust-the-published-host are contradictory — the first names the host ' +
				'the MCP credential may reach, the second accepts whatever this instance publishes. Pass one.'
		);
	}
	if (granteeMcpToken && !mcpHost && !trustPublishedHost) {
		// The bearer would otherwise travel to whatever `mcpAccess.mcpURL` named,
		// on the word of the server that named it.
		problems.push(
			'CONTENTUS_GRANTEE_MCP_TOKEN is set, so this run would send the grantee bearer to the MCP ' +
				'host THIS INSTANCE PUBLISHES. Name the host you expect with --mcp-host <host>, or accept ' +
				'whatever is published with --i-trust-the-published-host.'
		);
	}

	return {
		base,
		agent,
		grantee,
		execute,
		attribution,
		mcpHost,
		trustPublishedHost,
		ownerToken,
		granteeToken,
		granteeMcpToken,
		problems,
	};
}

/* -------------------------------------------------------------------------
 * Transport
 * ---------------------------------------------------------------------- */

/** POST one GraphQL document. Never returns a credential. */
async function graphql(fetchImpl, endpoint, token, query, variables = {}) {
	let response;
	try {
		response = await fetchImpl(endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({ query, variables }),
		});
	} catch (error) {
		return { ok: false, status: null, error: error?.message ?? String(error), data: null };
	}

	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, status: response.status, error: 'response was not JSON', data: null };
	}
	return {
		ok: response.ok && !body.errors?.length,
		status: response.status,
		errors: (body.errors ?? []).map((error) => error?.message ?? String(error)),
		data: body.data ?? null,
	};
}

/** One request against lesser's agent management plane (REST by lesser's design). */
async function rest(fetchImpl, base, method, path, token) {
	let response;
	try {
		response = await fetchImpl(`${base}${AGENTS_PATH}${path}`, {
			method,
			headers: { accept: 'application/json', authorization: `Bearer ${token}` },
		});
	} catch (error) {
		return { ok: false, status: null, error: error?.message ?? String(error), body: null };
	}

	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	return {
		ok: response.ok,
		status: response.status,
		body,
		error: response.ok ? null : (value(body?.error) ?? value(body?.message) ?? null),
	};
}

/** GET one public JSON document — anonymous, no credentials, sibling origin. */
async function publicJson(fetchImpl, url) {
	let response;
	try {
		response = await fetchImpl(url, { headers: { accept: 'application/json' } });
	} catch (error) {
		return { ok: false, status: null, error: error?.message ?? String(error), body: null };
	}
	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, status: response.status, error: 'response was not JSON', body: null };
	}
	return { ok: response.ok, status: response.status, body, error: null };
}

/**
 * One JSON-RPC call against an MCP endpoint.
 *
 * `initialize` and `tools/list` only — see the module header. The `accept` header
 * carries both media types because MCP's streamable HTTP transport may answer
 * either.
 */
async function jsonRpc(fetchImpl, endpoint, token, method, params = {}) {
	let response;
	try {
		response = await fetchImpl(endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
	} catch (error) {
		return { ok: false, status: null, error: error?.message ?? String(error), body: null };
	}

	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	return {
		ok: response.ok && !body?.error,
		status: response.status,
		body,
		challenge: response.headers?.get?.('www-authenticate') ?? null,
		error: body?.error?.message ?? null,
	};
}

/* -------------------------------------------------------------------------
 * The plan, which is also the dry run
 * ---------------------------------------------------------------------- */

/**
 * Every step in order, with the credential it uses and whether this process can
 * check it.
 *
 * One list, read twice: printed verbatim by a dry run and used by the summary to
 * name the steps a run left unproven. Two lists would drift, and the one that
 * drifted would be the one describing what was NOT done.
 */
export function plan({ agent, grantee, granteeMcpToken, attribution, mcpHost }) {
	const driven = granteeMcpToken ? 'checked' : 'attest';
	return [
		{
			id: 'owner-identity',
			kind: 'checked',
			credential: 'owner',
			what: 'viewer { id username } — the owner credential names an identity',
		},
		{
			id: 'grantee-identity',
			kind: 'checked',
			credential: 'grantee',
			what: 'viewer { id username } — the grantee credential names a DIFFERENT identity',
		},
		{
			id: 'preflight',
			kind: 'checked',
			credential: 'owner',
			what: `GET ${AGENTS_PATH}/${agent}/share — @${grantee} must not already hold active access`,
		},
		{
			id: 'share',
			kind: 'checked',
			credential: 'owner',
			what: `PUT ${AGENTS_PATH}/${agent}/share/${grantee} — WRITE: the grant this run creates`,
		},
		{
			id: 'grant-identity',
			kind: 'checked',
			credential: 'owner',
			what:
				'the grant just written carries a granted_at/granted_by stamp naming this run as its ' +
				'granter — the identity the revocation is aimed at',
		},
		{
			id: 'owner-sees-grant',
			kind: 'checked',
			credential: 'owner',
			what: `GET ${AGENTS_PATH}/${agent}/share — accessLedger().current names @${grantee}`,
		},
		{
			id: 'grantee-sees-agent',
			kind: 'checked',
			credential: 'grantee',
			what: `GET ${AGENTS_PATH}/shared-with-me — @${agent} is listed`,
		},
		{
			id: 'grantee-reads-endpoint',
			kind: 'checked',
			credential: 'grantee',
			what: 'AGENT_MCP_ACCESS_QUERY — lesser publishes an mcpURL to the grantee',
		},
		{
			id: 'mcp-host-verified',
			kind: mcpHost ? 'checked' : 'attest',
			credential: 'none',
			what: mcpHost
				? `the published mcpURL is on ${mcpHost} — the host this run was told to expect, checked ` +
					'before anything is sent to it'
				: 'NO EXPECTED MCP HOST NAMED — whatever host this instance publishes is accepted as served',
		},
		{
			id: 'discovery',
			kind: 'checked',
			credential: 'none',
			what: '/.well-known/mcp.json at the endpoint origin answers',
		},
		{
			id: 'protected-resource',
			kind: 'checked',
			credential: 'none',
			what: 'the RFC 9728 protected-resource document answers and names an authorization server',
		},
		{
			id: 'mcp-refuses-anonymous',
			kind: 'checked',
			credential: 'none',
			what: 'NEGATIVE CONTROL — an unauthenticated JSON-RPC initialize is REFUSED',
		},
		{
			id: 'mint',
			kind: 'attest',
			credential: 'grantee',
			what: 'the grantee mints an MCP credential through auth-ui (browser; never this probe)',
		},
		{
			id: 'drive',
			kind: driven,
			credential: 'grantee-mcp',
			what: 'JSON-RPC initialize + tools/list succeed for the grantee',
		},
		{
			id: 'recorded-action',
			kind: 'attest',
			credential: 'grantee-mcp',
			what: 'the grantee performs an action lesser records (the drive above writes no audit row)',
		},
		...(attribution
			? [
					{
						id: 'attribution',
						kind: 'checked',
						credential: 'owner',
						what: `AGENT_ACTIVITY_QUERY — driverLedger names @${grantee} as a driver`,
					},
				]
			: []),
		{
			id: 'revoke-target',
			kind: 'checked',
			credential: 'owner',
			what:
				`GET ${AGENTS_PATH}/${agent}/share re-read — the active grant is STILL the one this run ` +
				'created, or nothing is deleted',
		},
		{
			id: 'revoke',
			kind: 'checked',
			credential: 'owner',
			what: `DELETE ${AGENTS_PATH}/${agent}/share/${grantee} — WRITE: undoes the grant above`,
		},
		{
			id: 'owner-sees-revocation',
			kind: 'checked',
			credential: 'owner',
			what: `GET ${AGENTS_PATH}/${agent}/share — @${grantee} moves to accessLedger().revoked`,
		},
		{
			id: 'grantee-loses-agent',
			kind: 'checked',
			credential: 'grantee',
			what: `GET ${AGENTS_PATH}/shared-with-me — @${agent} is gone`,
		},
		{
			id: 'fail-closed',
			kind: driven,
			credential: 'grantee-mcp',
			what: 'the grantee MCP credential is refused after revocation',
		},
	];
}

/* -------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------- */

/** A nonempty string is an identity; anything else is not. */
const identity = (raw) => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null);

/** The usernames a grant list names, however the instance spelled them. */
const granteeNames = (grants) =>
	grants.map((grant) => value(grant?.grantee_username)?.toLowerCase()).filter(Boolean);

const agentNames = (grants) =>
	grants.map((grant) => value(grant?.agent_username)?.toLowerCase()).filter(Boolean);

/** Case-insensitive equality over two things lesser may have spelled either way. */
const sameName = (left, right) =>
	value(left) !== null && value(left).toLowerCase() === value(right)?.toLowerCase();

/**
 * The identity of the grant this run's `PUT` produced, or a refusal naming why
 * this run cannot claim to have produced one.
 *
 * WHAT THIS IS FOR. The revocation at the end of the flow is aimed at a row, and
 * this is the only description of that row this run will ever hold. Everything it
 * refuses is a case where the DELETE would be aimed at something else: a response
 * about a different agent or account, a row lesser stamped without the fields that
 * distinguish it, and — the case the preflight cannot cover — a row lesser says
 * SOMEBODY ELSE granted. lesser stores one row per grantee and re-grants it in
 * place, so a grant that landed between the preflight and this `PUT` is answered
 * by this `PUT` as an existing row carrying its original granter; that is a
 * standing grant this run adopted, not one it created, and it must survive.
 *
 * `owner` is the identity this run authenticated as, passed as the spellings the
 * viewer read supplied (username and id) because `granted_by` is a string and
 * which of the two an instance writes into it is the instance's business.
 */
export function createdGrant(body, { agent, grantee, owner }) {
	if (!body || typeof body !== 'object') {
		return { ok: false, reason: 'lesser answered the grant with no readable body' };
	}
	if (body.active !== true) {
		return { ok: false, reason: 'lesser accepted the grant but did not return it as active' };
	}
	if (!sameName(body.grantee_username, grantee)) {
		return {
			ok: false,
			reason:
				`lesser answered the grant with grantee ${value(body.grantee_username) ? `@${value(body.grantee_username)}` : 'unnamed'}, ` +
				`not the @${grantee} this run asked for`,
		};
	}
	if (!sameName(body.agent_username, agent)) {
		return {
			ok: false,
			reason:
				`lesser answered the grant with agent ${value(body.agent_username) ? `@${value(body.agent_username)}` : 'unnamed'}, ` +
				`not the @${agent} this run asked for`,
		};
	}
	const grantedAt = value(body.granted_at);
	const grantedBy = value(body.granted_by);
	if (!grantedAt || !grantedBy) {
		// Both are required by the contract. Without them there is nothing to tell
		// this row apart from one somebody else creates later in the run, and a
		// revocation aimed at "the row for this grantee" is the blind DELETE this
		// function exists to prevent.
		return {
			ok: false,
			reason:
				'lesser returned the grant without the granted_at/granted_by stamp that identifies it, ' +
				'so the revocation at the end of this run could not be aimed at the row this run wrote',
		};
	}
	if (!owner.some((spelling) => sameName(grantedBy, spelling))) {
		return {
			ok: false,
			reason:
				`lesser records @${grantedBy} as the granter of this row, not the ${owner
					.filter(Boolean)
					.map((spelling) => `@${spelling}`)
					.join(' / ')} ` +
				'this run authenticated as. The row predates this run — an account granted access to ' +
				'@' +
				grantee +
				' after the preflight read it as clear — and this run will NOT remove somebody else’s grant',
		};
	}
	return { ok: true, identity: { agent, grantee, grantedAt, grantedBy } };
}

/**
 * Whether a freshly-read share list still shows the grant this run created.
 *
 * Called immediately before every DELETE this file sends. Its answers are a
 * refusal or nothing — it never names a row to delete, because the row is already
 * named by `identity` and the only question is whether the instance still agrees.
 * A refusal leaves the grant standing, which is the safe side of this decision:
 * an access grant left in place is a line in an operator's runbook, and one
 * deleted is somebody's access gone with no record of what it was.
 */
export function grantToRevoke(ledger, identity) {
	if (ledger.unreadable.length) {
		return {
			ok: false,
			reason:
				`this instance sent ${ledger.unreadable.length} share entr` +
				`${ledger.unreadable.length === 1 ? 'y' : 'ies'} without marking them active or revoked, ` +
				'so which row is the one this run created cannot be established',
		};
	}
	const matches = ledger.current.filter(
		(grant) =>
			sameName(grant?.grantee_username, identity.grantee) &&
			sameName(grant?.agent_username, identity.agent)
	);
	if (!matches.length) {
		return {
			ok: false,
			reason:
				`the grant this run created is no longer in @${identity.agent}'s current-access list. ` +
				'Something else revoked or removed it while this run was in flight, and a DELETE now ' +
				'would be aimed at whatever has taken its place',
		};
	}
	if (matches.length > 1) {
		return {
			ok: false,
			reason:
				`this instance names ${matches.length} active grants for @${identity.grantee} on ` +
				`@${identity.agent}. lesser stores one row per grantee, so this run's model of the ` +
				'share list is wrong and it will not guess which row is its own',
		};
	}
	const [grant] = matches;
	const grantedAt = value(grant?.granted_at);
	const grantedBy = value(grant?.granted_by);
	if (grantedAt !== identity.grantedAt || !sameName(grantedBy, identity.grantedBy)) {
		return {
			ok: false,
			reason:
				`@${identity.grantee}'s active grant on @${identity.agent} now reads ` +
				`${grantedAt ? `granted ${grantedAt}` : 'granted at no stated time'}` +
				`${grantedBy ? ` by @${grantedBy}` : ' by nobody stated'}, not the granted ` +
				`${identity.grantedAt} by @${identity.grantedBy} this run created. It has been re-granted ` +
				'since, so it is somebody else’s standing grant and this run will NOT revoke it',
		};
	}
	return { ok: true };
}

/**
 * The ONLY place this file sends a DELETE.
 *
 * Re-reads the share list and hands it to `grantToRevoke` first, so the check and
 * the write cannot drift apart and no caller can reach the write without it. Both
 * callers — the flow's own revocation and the cleanup that runs after a failure —
 * go through here, because the cleanup path is the one that runs when everything
 * else has already gone wrong and is therefore the one that must not guess.
 */
async function revokeOwnGrant(fetchImpl, options, identity) {
	const list = await rest(
		fetchImpl,
		options.base,
		'GET',
		`/${encodeURIComponent(options.agent)}/share`,
		options.ownerToken
	);
	if (!list.ok || !Array.isArray(list.body?.grants)) {
		return {
			matched: false,
			reason:
				`the owner's share list could not be re-read before revoking (HTTP ` +
				`${list.status ?? 'no response'}${list.error ? `: ${list.error}` : ''}), so the grant ` +
				'this run created could not be told apart from any other',
			revoke: null,
		};
	}
	const verdict = grantToRevoke(accessLedger(list.body.grants), identity);
	if (!verdict.ok) return { matched: false, reason: verdict.reason, revoke: null };

	const revoke = await rest(
		fetchImpl,
		options.base,
		'DELETE',
		`/${encodeURIComponent(options.agent)}/share/${encodeURIComponent(options.grantee)}`,
		options.ownerToken
	);
	return { matched: true, reason: null, revoke };
}

export async function main(
	argv,
	{
		fetchImpl = globalThis.fetch,
		env = process.env,
		write = (text) => process.stdout.write(text),
	} = {}
) {
	const options = readOptions(argv, env);
	// Bound before anything is written, so the redactor covers the failure paths too.
	const say = redactingAll(write, [
		options.ownerToken,
		options.granteeToken,
		options.granteeMcpToken,
	]);

	if (options.problems.length) {
		say('probe-share-flow: cannot run\n');
		for (const problem of options.problems) say(`  - ${problem}\n`);
		say(
			'\n  usage: node --experimental-strip-types scripts/probe-share-flow.mjs \\\n' +
				'           --base https://<instance> --agent <agent-username> --grantee <account> [--execute]\n'
		);
		return 1;
	}

	const steps = plan(options);

	say(`probe-share-flow: ${options.base}\n`);
	say(`  agent @${options.agent}, grantee @${options.grantee}\n\n`);

	if (!options.execute) {
		say('DRY RUN — nothing is sent. Add --execute to run this against the instance.\n\n');
		steps.forEach((step, index) => {
			const mark = step.kind === 'checked' ? 'CHECK ' : 'ATTEST';
			say(`  ${String(index + 1).padStart(2)}. [${mark}] ${step.what}\n`);
			say(`        credential: ${step.credential}\n`);
		});
		const attests = steps.filter((step) => step.kind === 'attest');
		say(
			`\nprobe-share-flow: ${steps.length - attests.length} steps would be checked by this ` +
				`process; ${attests.length} would be left to the operator's own record.\n`
		);
		if (!options.granteeMcpToken) {
			say(
				'  Set CONTENTUS_GRANTEE_MCP_TOKEN to move the drive and the post-revoke fail-closed\n' +
					'  check from ATTEST to CHECK. A run carrying it must also say which MCP host that\n' +
					'  credential may reach: --mcp-host <host>, or --i-trust-the-published-host.\n'
			);
		}
		if (!options.mcpHost) {
			say(
				'  --mcp-host <host> would move the published-endpoint check from ATTEST to CHECK, and\n' +
					'  is what stops a credential travelling to a host this instance simply asserted.\n'
			);
		}
		if (!options.attribution) {
			say('  --no-attribution: this run would NOT check that the grantee is attributed.\n');
		}
		return 0;
	}

	/* --- the live run ---------------------------------------------------- */

	const endpoint = `${options.base}${GRAPHQL_PATH}`;
	const results = [];
	// `identity` is what the cleanup is allowed to delete. It stays null until
	// lesser has named the row this run wrote, and a null one means the cleanup
	// refuses rather than falling back to "the row for this grantee".
	const state = { shareCreated: false, revoked: false, identity: null };

	const pass = (id, detail) => {
		results.push({ id, ok: true });
		say(`  [PASS] ${id}${detail ? ` — ${detail}` : ''}\n`);
	};
	const fail = (id, detail) => {
		results.push({ id, ok: false });
		say(`  [FAIL] ${id}${detail ? ` — ${detail}` : ''}\n`);
		return false;
	};
	const attest = (id, detail) => {
		results.push({ id, attest: true });
		say(`  [ATTEST] ${id}${detail ? ` — ${detail}` : ''}\n`);
	};

	// `flow` returns false the moment a step fails; the cleanup below still runs.
	const flow = async () => {
		// 1-2. Two credentials, two identities.
		const ownerViewer = await graphql(
			fetchImpl,
			endpoint,
			options.ownerToken,
			VIEWER_IDENTITY_QUERY
		);
		const ownerId = identity(ownerViewer.data?.viewer?.id);
		const ownerName = identity(ownerViewer.data?.viewer?.username);
		if (!ownerViewer.ok || !ownerId || !ownerName) {
			return fail(
				'owner-identity',
				`lesser named no identity for the owner credential${ownerViewer.errors?.length ? `: ${ownerViewer.errors[0]}` : ''}`
			);
		}
		pass('owner-identity', `@${ownerName} (${ownerId})`);

		const granteeViewer = await graphql(
			fetchImpl,
			endpoint,
			options.granteeToken,
			VIEWER_IDENTITY_QUERY
		);
		const granteeId = identity(granteeViewer.data?.viewer?.id);
		const granteeName = identity(granteeViewer.data?.viewer?.username);
		if (!granteeViewer.ok || !granteeId || !granteeName) {
			return fail(
				'grantee-identity',
				`lesser named no identity for the grantee credential${granteeViewer.errors?.length ? `: ${granteeViewer.errors[0]}` : ''}`
			);
		}
		if (granteeId === ownerId) {
			return fail(
				'grantee-identity',
				'both credentials resolve to the same account; sharing an agent with yourself ' +
					'walks every route and demonstrates none of the flow'
			);
		}
		if (granteeName.toLowerCase() !== options.grantee.toLowerCase()) {
			return fail(
				'grantee-identity',
				`the grantee credential belongs to @${granteeName}, not the --grantee @${options.grantee}; ` +
					'the run would grant access to one account and check another'
			);
		}
		pass('grantee-identity', `@${granteeName} (${granteeId}), distinct from the owner`);

		// 3. Preflight: never revoke access this run did not create.
		const before = await rest(
			fetchImpl,
			options.base,
			'GET',
			`/${encodeURIComponent(options.agent)}/share`,
			options.ownerToken
		);
		if (!before.ok || !Array.isArray(before.body?.grants)) {
			return fail(
				'preflight',
				`the owner's share list could not be read (HTTP ${before.status ?? 'no response'}${before.error ? `: ${before.error}` : ''})`
			);
		}
		const ledgerBefore = accessLedger(before.body.grants);
		if (granteeNames(ledgerBefore.current).includes(options.grantee.toLowerCase())) {
			return fail(
				'preflight',
				`@${options.grantee} ALREADY holds active access to @${options.agent}. This run ends by ` +
					'revoking, and revoking a standing grant nobody asked to remove is not a cost this ' +
					'probe may impose. Nothing was written.'
			);
		}
		if (ledgerBefore.unreadable.length) {
			// An entry lesser did not classify could be the grantee's; treating the
			// list as settled would put the guarantee above on a guess.
			return fail(
				'preflight',
				`this instance sent ${ledgerBefore.unreadable.length} share entr` +
					`${ledgerBefore.unreadable.length === 1 ? 'y' : 'ies'} without marking them active or ` +
					'revoked, so "the grantee holds no access" cannot be established. Nothing was written.'
			);
		}
		pass('preflight', `@${options.grantee} holds no access to @${options.agent}`);

		// 4. The share. The first write.
		const granted = await rest(
			fetchImpl,
			options.base,
			'PUT',
			`/${encodeURIComponent(options.agent)}/share/${encodeURIComponent(options.grantee)}`,
			options.ownerToken
		);
		if (!granted.ok) {
			return fail(
				'share',
				`HTTP ${granted.status ?? 'no response'}${granted.error ? `: ${granted.error}` : ''}`
			);
		}
		state.shareCreated = true;
		pass('share', `@${options.grantee} granted access to @${options.agent}`);

		// The identity the revocation will be aimed at, captured at the moment the
		// row was written. Everything after this point can take as long as it takes.
		const created = createdGrant(granted.body, {
			agent: options.agent,
			grantee: options.grantee,
			owner: [ownerName, ownerId],
		});
		if (!created.ok) return fail('grant-identity', created.reason);
		state.identity = created.identity;
		pass(
			'grant-identity',
			`granted ${created.identity.grantedAt} by @${created.identity.grantedBy}`
		);

		// 5. The owner's view of it.
		const after = await rest(
			fetchImpl,
			options.base,
			'GET',
			`/${encodeURIComponent(options.agent)}/share`,
			options.ownerToken
		);
		if (!after.ok || !Array.isArray(after.body?.grants)) {
			return fail('owner-sees-grant', `HTTP ${after.status ?? 'no response'}`);
		}
		if (
			!granteeNames(accessLedger(after.body.grants).current).includes(options.grantee.toLowerCase())
		) {
			return fail(
				'owner-sees-grant',
				`the owner's current-access list does not name @${options.grantee}`
			);
		}
		pass('owner-sees-grant', "the grant appears in the owner's current-access list");

		// 6. The grantee's view of it.
		const sharedWithMe = await rest(
			fetchImpl,
			options.base,
			'GET',
			'/shared-with-me',
			options.granteeToken
		);
		if (!sharedWithMe.ok || !Array.isArray(sharedWithMe.body?.grants)) {
			return fail('grantee-sees-agent', `HTTP ${sharedWithMe.status ?? 'no response'}`);
		}
		if (
			!agentNames(accessLedger(sharedWithMe.body.grants).current).includes(
				options.agent.toLowerCase()
			)
		) {
			return fail(
				'grantee-sees-agent',
				`@${options.agent} is not in the grantee's shared-with-me list`
			);
		}
		pass('grantee-sees-agent', `@${options.agent} is listed for the grantee`);

		// 7. The endpoint the UI shows the grantee.
		const access = await graphql(
			fetchImpl,
			endpoint,
			options.granteeToken,
			AGENT_MCP_ACCESS_QUERY,
			{
				username: options.agent,
			}
		);
		if (!access.ok) {
			return fail(
				'grantee-reads-endpoint',
				`the MCP access read failed${access.errors?.length ? `: ${access.errors[0]}` : ''}`
			);
		}
		const mcpUrl = identity(access.data?.agent?.mcpAccess?.mcpURL);
		if (!mcpUrl) {
			return fail(
				'grantee-reads-endpoint',
				'this instance publishes no MCP endpoint for this agent, so there is nothing for the ' +
					'grantee to connect to. That is a served answer, not a transport failure.'
			);
		}
		let published;
		try {
			published = new URL(mcpUrl);
		} catch {
			return fail('grantee-reads-endpoint', 'lesser published an mcpURL this probe cannot parse');
		}
		const origin = published.origin;
		pass('grantee-reads-endpoint', mcpUrl);

		// 8. Whose host is this? Answered BEFORE the first request reaches it, so a
		//    host the operator did not expect gets nothing at all from this run —
		//    the grantee's bearer least of all.
		const publishedHost = published.host.toLowerCase();
		if (options.mcpHost) {
			if (publishedHost !== options.mcpHost) {
				return fail(
					'mcp-host-verified',
					`this instance publishes its MCP endpoint on ${publishedHost}, not the ` +
						`${options.mcpHost} this run was told to expect. NOTHING was sent to it — the ` +
						"grantee's credential was not offered to a host nobody vouched for. Either the " +
						'instance is misconfigured or --mcp-host is out of date; both are worth knowing ' +
						'before a bearer travels.'
				);
			}
			pass('mcp-host-verified', publishedHost);
		} else {
			attest(
				'mcp-host-verified',
				`the published host ${publishedHost} was accepted as served; no expected host was named`
			);
			if (options.granteeMcpToken) {
				say(
					`\n  !! --i-trust-the-published-host: the grantee's MCP credential will be sent to\n` +
						`     ${publishedHost}, a host THIS INSTANCE PUBLISHED and nobody verified. Re-run\n` +
						`     with --mcp-host ${publishedHost} to pin it.\n\n`
				);
			}
		}

		// 9-10. The documents a client needs to authorize against it.
		const discovery = await publicJson(
			fetchImpl,
			new URL('/.well-known/mcp.json', origin).toString()
		);
		if (!discovery.ok) {
			return fail(
				'discovery',
				`HTTP ${discovery.status ?? 'no response'}${discovery.error ? `: ${discovery.error}` : ''}`
			);
		}
		pass('discovery', `${discovery.body?.tools?.length ?? 0} tools published`);

		const protectedUrl =
			identity(access.data?.agent?.mcpAccess?.protectedResourceURL) ??
			new URL('/.well-known/oauth-protected-resource', origin).toString();
		const protectedDoc = await publicJson(fetchImpl, protectedUrl);
		if (!protectedDoc.ok) {
			return fail('protected-resource', `HTTP ${protectedDoc.status ?? 'no response'}`);
		}
		const servers = Array.isArray(protectedDoc.body?.authorization_servers)
			? protectedDoc.body.authorization_servers.filter((entry) => identity(entry))
			: [];
		if (!servers.length) {
			return fail(
				'protected-resource',
				'the document names no authorization server, so a client has nowhere to authorize'
			);
		}
		pass('protected-resource', `authorization server ${servers[0]}`);

		// 10. The negative control. Without it a green run proves the endpoint
		//     answers, not that it gates.
		const anonymous = await jsonRpc(fetchImpl, mcpUrl, null, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'contentus-probe-share-flow', version: '0' },
		});
		if (anonymous.ok || (anonymous.status !== 401 && anonymous.status !== 403)) {
			return fail(
				'mcp-refuses-anonymous',
				`an unauthenticated initialize was answered HTTP ${anonymous.status ?? 'no response'}; ` +
					'this endpoint is not gated and the whole flow proves nothing about access'
			);
		}
		pass(
			'mcp-refuses-anonymous',
			`HTTP ${anonymous.status}${anonymous.challenge ? `, challenge ${anonymous.challenge}` : ''}`
		);

		// 11-13. The credential is minted in a browser; this probe never holds one
		//        it made itself.
		attest('mint', 'the grantee minted an MCP credential through auth-ui');

		if (options.granteeMcpToken) {
			const init = await jsonRpc(fetchImpl, mcpUrl, options.granteeMcpToken, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'contentus-probe-share-flow', version: '0' },
			});
			if (!init.ok) {
				return fail(
					'drive',
					`initialize was refused HTTP ${init.status ?? 'no response'}${init.error ? `: ${init.error}` : ''}`
				);
			}
			const tools = await jsonRpc(fetchImpl, mcpUrl, options.granteeMcpToken, 'tools/list');
			if (!tools.ok) {
				return fail('drive', `tools/list was refused HTTP ${tools.status ?? 'no response'}`);
			}
			pass(
				'drive',
				`the grantee's session is live (${tools.body?.result?.tools?.length ?? 0} tools); ` +
					'read-only, so it writes no audit row'
			);
		} else {
			attest('drive', 'the grantee connected a client to the endpoint and drove the agent');
		}

		attest(
			'recorded-action',
			'the grantee performed an action lesser records as an `agent.` event'
		);

		// 14. Observe: the owner sees the grantee in the attribution.
		if (options.attribution) {
			const activity = await graphql(
				fetchImpl,
				endpoint,
				options.ownerToken,
				AGENT_ACTIVITY_QUERY,
				{
					username: options.agent,
					first: 100,
				}
			);
			if (!activity.ok) {
				return fail(
					'attribution',
					`the activity read failed${activity.errors?.length ? `: ${activity.errors[0]}` : ''}`
				);
			}
			const edges = activity.data?.agentActivity?.edges;
			if (!Array.isArray(edges)) {
				return fail(
					'attribution',
					'this instance returned an activity list this probe cannot read'
				);
			}
			const ledger = driverLedger(
				edges.map((edge) => edge?.node),
				{ more: activity.data?.agentActivity?.pageInfo?.hasNextPage === true }
			);
			const wanted = driverKey(driverLabel(options.grantee) ?? `@${options.grantee}`);
			const found = ledger.drivers.find((driver) => driverKey(driver.label) === wanted);
			say(
				`         ${ledger.actions.length} actions read, ${ledger.drivers.length} drivers named, ` +
					`${ledger.unnamed} unnamed, ${ledger.unreadable} unreadable${ledger.more ? ', more not fetched' : ''}\n`
			);
			if (!found) {
				return fail(
					'attribution',
					`@${options.grantee} is not among the drivers lesser named. If the grantee has not yet ` +
						"performed a RECORDED action, that is what this step is waiting for — the probe's own " +
						'drive is read-only and writes no row.'
				);
			}
			pass(
				'attribution',
				`${found.label} named on ${found.actions} action${found.actions === 1 ? '' : 's'} ` +
					`via ${found.mechanisms.join(' and ')}`
			);
		}

		// 15. The revocation — aimed at the row this run wrote, re-checked against a
		//     fresh read taken right here rather than at the preflight.
		const attempt = await revokeOwnGrant(fetchImpl, options, state.identity);
		if (!attempt.matched) {
			return fail('revoke-target', `${attempt.reason}. NOTHING was deleted.`);
		}
		pass('revoke-target', 'the active grant is still the one this run created');

		const revoked = attempt.revoke;
		if (!revoked.ok) {
			return fail(
				'revoke',
				`HTTP ${revoked.status ?? 'no response'}${revoked.error ? `: ${revoked.error}` : ''}`
			);
		}
		state.revoked = true;
		if (revoked.body?.active !== false) {
			return fail(
				'revoke',
				'lesser accepted the revocation but did not return the grant as inactive'
			);
		}
		pass('revoke', `@${options.grantee}'s access to @${options.agent} revoked`);

		// 16-17. Both sides see it gone.
		const afterRevoke = await rest(
			fetchImpl,
			options.base,
			'GET',
			`/${encodeURIComponent(options.agent)}/share`,
			options.ownerToken
		);
		if (!afterRevoke.ok || !Array.isArray(afterRevoke.body?.grants)) {
			return fail('owner-sees-revocation', `HTTP ${afterRevoke.status ?? 'no response'}`);
		}
		const ledgerAfter = accessLedger(afterRevoke.body.grants);
		if (granteeNames(ledgerAfter.current).includes(options.grantee.toLowerCase())) {
			return fail(
				'owner-sees-revocation',
				`@${options.grantee} is STILL in the current-access list`
			);
		}
		if (!granteeNames(ledgerAfter.revoked).includes(options.grantee.toLowerCase())) {
			return fail(
				'owner-sees-revocation',
				`@${options.grantee} is in neither list after revocation`
			);
		}
		pass('owner-sees-revocation', "the grant moved to the owner's revoked list");

		const granteeAfter = await rest(
			fetchImpl,
			options.base,
			'GET',
			'/shared-with-me',
			options.granteeToken
		);
		if (!granteeAfter.ok || !Array.isArray(granteeAfter.body?.grants)) {
			return fail('grantee-loses-agent', `HTTP ${granteeAfter.status ?? 'no response'}`);
		}
		if (
			agentNames(accessLedger(granteeAfter.body.grants).current).includes(
				options.agent.toLowerCase()
			)
		) {
			return fail('grantee-loses-agent', `@${options.agent} is still listed for the grantee`);
		}
		pass('grantee-loses-agent', `@${options.agent} is gone from the grantee's list`);

		// 18. Fail closed.
		if (options.granteeMcpToken) {
			const afterToken = await jsonRpc(fetchImpl, mcpUrl, options.granteeMcpToken, 'tools/list');
			if (afterToken.ok || (afterToken.status !== 401 && afterToken.status !== 403)) {
				return fail(
					'fail-closed',
					`the grantee's MCP credential was answered HTTP ${afterToken.status ?? 'no response'} ` +
						'AFTER revocation; access outlived the grant'
				);
			}
			pass('fail-closed', `the revoked grantee's credential is refused HTTP ${afterToken.status}`);
		} else {
			attest('fail-closed', "the grantee's MCP session dropped and re-login was refused");
		}

		return true;
	};

	let completed = false;
	try {
		completed = await flow();
	} catch (error) {
		fail('run', `the probe threw: ${error?.message ?? String(error)}`);
	}

	/* --- cleanup: never leave a grant this run created ------------------- */

	if (state.shareCreated && !state.revoked) {
		say('\nprobe-share-flow: CLEANUP — revoking the grant this run created\n');
		if (!state.identity) {
			// The `PUT` went out and lesser never named the row it produced, so there
			// is nothing to aim at. Deleting "the grant for this grantee" here is
			// exactly the blind revocation the identity exists to prevent, and a
			// cleanup that does it while a run is already failing is the worst place
			// for it. Say so at the top of the operator's voice instead.
			say(
				`  [CLEANUP REFUSED] this run wrote a grant it could not identify, so it will NOT ` +
					`delete one. @${options.grantee} MAY STILL HOLD ACCESS to @${options.agent} — check ` +
					`the Sharing @${options.agent} panel and revoke by hand before leaving this instance.\n`
			);
			results.push({ id: 'cleanup', ok: false });
		} else {
			const undo = await revokeOwnGrant(fetchImpl, options, state.identity);
			if (!undo.matched) {
				say(
					`  [CLEANUP REFUSED] ${undo.reason}. NOTHING was deleted, and @${options.grantee} MAY ` +
						`STILL HOLD ACCESS to @${options.agent}. Check the Sharing @${options.agent} panel ` +
						'and revoke by hand before leaving this instance.\n'
				);
				results.push({ id: 'cleanup', ok: false });
			} else if (undo.revoke.ok) {
				say(`  [CLEANUP] @${options.grantee}'s access to @${options.agent} was revoked\n`);
			} else {
				say(
					`  [CLEANUP FAILED] HTTP ${undo.revoke.status ?? 'no response'} — @${options.grantee} ` +
						`MAY STILL HOLD ACCESS to @${options.agent}. Revoke it by hand before leaving this ` +
						'instance.\n'
				);
				results.push({ id: 'cleanup', ok: false });
			}
		}
	}

	/* --- the summary, which names what was not proven -------------------- */

	const checked = results.filter((result) => !result.attest);
	const failures = checked.filter((result) => !result.ok);
	const attested = results.filter((result) => result.attest);

	say(
		`\nprobe-share-flow: ${checked.length - failures.length}/${checked.length} checked steps passed\n`
	);
	if (attested.length) {
		say(
			`probe-share-flow: ${attested.length} step${attested.length === 1 ? '' : 's'} ` +
				`THIS RUN DID NOT PROVE — they stand on the operator's own record:\n`
		);
		for (const step of attested) {
			say(`  - ${steps.find((entry) => entry.id === step.id)?.what ?? step.id}\n`);
		}
	}
	if (!options.attribution) {
		say(
			'probe-share-flow: --no-attribution — the grantee was NOT checked against the activity log.\n'
		);
	}
	if (!completed && !failures.length) {
		// A flow that stopped without a recorded failure would otherwise print a
		// clean tally for a run that never reached the end.
		say(
			'probe-share-flow: the run did not complete, and the tally above covers only what it reached.\n'
		);
		return 1;
	}

	return failures.length === 0 && completed ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv.slice(2)));
}
