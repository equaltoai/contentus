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

	return {
		base,
		agent,
		grantee,
		execute,
		attribution,
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
export function plan({ agent, grantee, granteeMcpToken, attribution }) {
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
					'  check from ATTEST to CHECK.\n'
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
	const state = { shareCreated: false, revoked: false };

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
		if (granted.body?.active !== true) {
			return fail('share', 'lesser accepted the grant but did not return it as active');
		}
		pass('share', `@${options.grantee} granted access to @${options.agent}`);

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
		let origin;
		try {
			origin = new URL(mcpUrl).origin;
		} catch {
			return fail('grantee-reads-endpoint', 'lesser published an mcpURL this probe cannot parse');
		}
		pass('grantee-reads-endpoint', mcpUrl);

		// 8-9. The documents a client needs to authorize against it.
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

		// 15. The revocation.
		const revoked = await rest(
			fetchImpl,
			options.base,
			'DELETE',
			`/${encodeURIComponent(options.agent)}/share/${encodeURIComponent(options.grantee)}`,
			options.ownerToken
		);
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
		const undo = await rest(
			fetchImpl,
			options.base,
			'DELETE',
			`/${encodeURIComponent(options.agent)}/share/${encodeURIComponent(options.grantee)}`,
			options.ownerToken
		);
		if (undo.ok) {
			say(`  [CLEANUP] @${options.grantee}'s access to @${options.agent} was revoked\n`);
		} else {
			say(
				`  [CLEANUP FAILED] HTTP ${undo.status ?? 'no response'} — @${options.grantee} MAY STILL ` +
					`HOLD ACCESS to @${options.agent}. Revoke it by hand before leaving this instance.\n`
			);
			results.push({ id: 'cleanup', ok: false });
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
