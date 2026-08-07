import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { compile } from 'svelte/compiler';

import {
	AGENTS_ROSTER_QUERY,
	agentUnavailableFromErrors,
	fetchAgentRoster,
	isAgentsDisabledError,
	toAgentRosterPage,
	toAgentSummary,
} from '../src/lib/agents/contract.ts';
import {
	emptyRosterMessage,
	hasActiveFilters,
	resolveAgentFilters,
} from '../src/lib/agents/filters.ts';
import {
	computedImports,
	liveScript,
	modulePath,
	moduleSpecifiers,
} from '../scripts/lib/module-imports.mjs';
import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';
import { renderComponent } from './helpers/svelte-server.mjs';
import { MODULE_SOURCE, trackedSource } from './helpers/tracked-source.mjs';

const ROSTER_ENDPOINT = 'https://instance.invalid/api/graphql';

/**
 * `fetchAgentRoster` against a stubbed `fetch`, recording what was sent.
 *
 * The same shape `tests/agents-trust.test.mjs`'s `heldRead` uses, without the
 * held-open gate: the roster became a CLIENT read when lesser's gateway began
 * refusing anonymous `agents` operations, so the behaviours the SSR section
 * used to pin through the built handler — filters travelling, failures
 * degrading — are now pinned at the contract layer the client actually calls.
 */
function stubbedFetch(respond) {
	const requests = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		const request = {
			url: typeof input === 'string' ? input : String(input?.url ?? input),
			operation: /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '',
			variables: payload.variables ?? {},
			authorization: new Headers(init.headers).get('authorization'),
		};
		requests.push(request);

		const envelope = respond(request) ?? { data: null };
		if (envelope.httpStatus && !envelope.data && !envelope.errors) {
			return new Response('Service Unavailable', { status: envelope.httpStatus });
		}
		return new Response(JSON.stringify(envelope), {
			status: envelope.httpStatus ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	return {
		requests,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

/** An agent as lesser's `Agents` resolver converts one. */
function agentNode(overrides = {}) {
	return {
		id: 'https://example.invalid/users/weatherbot',
		username: 'weatherbot',
		displayName: 'Weather Bot',
		bio: 'Posts the forecast.',
		agentType: 'CURATOR',
		agentVersion: '1.4.0',
		verified: true,
		verifiedAt: '2026-06-01T00:00:00Z',
		quarantineStatus: null,
		quarantineStart: null,
		quarantineEnd: null,
		quarantineActive: false,
		createdAt: '2026-01-01T00:00:00Z',
		activityCount: 1280,
		agentCapabilities: {
			canPost: true,
			canReply: true,
			canBoost: false,
			canFollow: true,
			canDM: false,
			maxPostsPerHour: 12,
			requiresApproval: false,
			restrictedDomains: [],
		},
		mcpAccess: {
			mcpURL: 'https://api.example.invalid/mcp/weatherbot',
			protectedResourceURL:
				'https://api.example.invalid/.well-known/oauth-protected-resource/mcp/weatherbot',
			authorizationServerURL: 'https://example.invalid/.well-known/oauth-authorization-server',
			registrationURL: 'https://example.invalid/oauth/register',
			scopes: ['read', 'write', 'follow', 'push'],
			guidance: ['Start from the actor-scoped MCP URL.'],
		},
		...overrides,
	};
}

function connection(nodes, pageInfo = {}) {
	return {
		totalCount: nodes.length,
		pageInfo: { hasNextPage: false, endCursor: null, ...pageInfo },
		edges: nodes.map((node, index) => ({ cursor: `c${index}`, node })),
	};
}

/* -------------------------------------------------------------------------
 * Contract consumption
 * ---------------------------------------------------------------------- */

test('the roster asks for the preferred field names, not the deprecated aliases', () => {
	// lesser marks `type`/`version`/`capabilities` deprecated in favour of the
	// REST-parity names. Selecting the deprecated ones would still work and would
	// still be wrong.
	assert.match(AGENTS_ROSTER_QUERY, /agentType/);
	assert.match(AGENTS_ROSTER_QUERY, /agentVersion/);
	assert.match(AGENTS_ROSTER_QUERY, /agentCapabilities/);

	// `ownerUsername` is owner-scoped: lesser rejects it anonymously and permits
	// only the caller's own username otherwise, so as a roster filter it is
	// `myAgents` spelled a second way. Asking for it here would error the roster
	// for every reader but one.
	assert.ok(
		!AGENTS_ROSTER_QUERY.includes('ownerUsername'),
		'the roster must not send an argument lesser refuses for most readers'
	);
});

test('totalCount is carried as a per-page count, because that is what it is', () => {
	// lesser filters AFTER paging, so `totalCount` counts matches within the page
	// it just read. The field name in the view model is the guard against a
	// surface rendering it as an instance total.
	const page = toAgentRosterPage(connection([agentNode(), agentNode({ id: 'b', username: 'b' })]));

	assert.equal(page.matchesOnThisPage, 2);
	assert.ok(!('totalCount' in page), 'the ambiguous name must not survive normalisation');
});

test('hasNextPage comes from lesser, never from page length', () => {
	// The case that matters: a page filtered down to nothing that still has more
	// pages behind it. Inferring "no results" from an empty array would be wrong.
	const page = toAgentRosterPage(connection([], { hasNextPage: true, endCursor: 'c9' }));

	assert.deepEqual(page.agents, []);
	assert.equal(page.hasNextPage, true);
	assert.equal(page.endCursor, 'c9');
});

test('redacted owner fields are absent rather than empty', () => {
	// lesser blanks `agentOwner` to null and `delegatedScopes` to [] for
	// non-owners. Rendering those as facts would tell every non-owner reader
	// that every agent has no owner and no scopes.
	const anonymous = toAgentSummary(agentNode({ agentOwner: null, delegatedScopes: [] }), false);
	assert.equal(anonymous.owner, null);
	assert.equal(anonymous.redaction.viewerIsOwner, false);

	const asOwner = toAgentSummary(
		agentNode({ agentOwner: 'https://example.invalid/users/ada', delegatedScopes: ['read'] }),
		true
	);
	assert.equal(asOwner.owner.agentOwner, 'https://example.invalid/users/ada');
	assert.deepEqual(asOwner.owner.delegatedScopes, ['read']);
});

test('an unknown agent type becomes CUSTOM, matching lesser’s own normaliser', () => {
	assert.equal(toAgentSummary(agentNode({ agentType: 'SOMETHING_NEW' })).agentType, 'CUSTOM');
	assert.equal(toAgentSummary(agentNode({ agentType: 'BRIDGE' })).agentType, 'BRIDGE');
});

test('a nameless agent falls back to its handle rather than rendering blank', () => {
	assert.equal(toAgentSummary(agentNode({ displayName: '' })).displayName, 'weatherbot');
});

test('the agents-disabled refusal is told apart from other refusals', () => {
	assert.equal(
		isAgentsDisabledError([{ message: 'agents are disabled by instance policy' }]),
		true
	);
	assert.equal(isAgentsDisabledError([{ message: 'agents are disabled' }]), true);

	// The narrowness is the point: a quarantine message also contains "disabled"
	// in some phrasings, and must not be read as the instance switching agents off.
	assert.equal(isAgentsDisabledError([{ message: 'this agent is disabled by quarantine' }]), false);

	assert.equal(
		agentUnavailableFromErrors([{ message: 'agents are disabled' }]).reason,
		'agents-disabled'
	);
	assert.equal(
		agentUnavailableFromErrors([{ message: 'authentication required' }]).reason,
		'unauthenticated'
	);
});

/* -------------------------------------------------------------------------
 * Filters as addresses
 * ---------------------------------------------------------------------- */

test('filters round-trip through the query string', () => {
	const filters = resolveAgentFilters({
		type: ['CURATOR'],
		q: ['weather'],
		verified: ['true'],
		after: ['cursor-9'],
	});

	assert.deepEqual(filters, {
		type: 'CURATOR',
		query: 'weather',
		verified: true,
		after: 'cursor-9',
	});
	assert.equal(hasActiveFilters(filters), true);
});

test('verified is tri-state: absent, true and false are three different questions', () => {
	assert.equal(resolveAgentFilters({}).verified, null);
	assert.equal(resolveAgentFilters({ verified: ['true'] }).verified, true);
	// Not collapsed into null — lesser reads `false` as "unverified only".
	assert.equal(resolveAgentFilters({ verified: ['false'] }).verified, false);
});

test('an unrecognised type is dropped rather than passed to lesser', () => {
	// An invalid enum value would fail the whole query; the unfiltered roster is
	// the nearest honest reading of a malformed filter.
	assert.equal(resolveAgentFilters({ type: ['NOT_A_TYPE'] }).type, null);
	// Case is normalised, because a hand-typed lowercase filter means the type.
	assert.equal(resolveAgentFilters({ type: ['curator'] }).type, 'CURATOR');
});

test('paging alone is not a filter', () => {
	assert.equal(hasActiveFilters(resolveAgentFilters({ after: ['c1'] })), false);
});

test('the rendered roster links each card to its agent, under the lesser base path', async () => {
	// Asserted against the component's paint rather than against the href
	// builder, because what has to be right is the link a reader actually
	// receives — including the `/l` base path lesser's SSR host forwards under.
	// The roster is a session read now (the gateway refuses anonymous
	// `agents`), so the paint is the component's rather than the built
	// handler's; the props are the same either way.
	const page = toAgentRosterPage(connection([agentNode()]));
	const html = await renderComponent('src/lib/agents/AgentRoster.svelte', {
		page,
		failure: null,
		filters: resolveAgentFilters({}),
	});

	assert.ok(html.includes('href="/l/agents/weatherbot"'), 'card links to the agent');
});

test('the next-page link carries the filters as well as the cursor', async () => {
	// A cursor without its filters resumes a different list. Both have to travel.
	const filters = resolveAgentFilters({ type: ['CURATOR'], q: ['weather'], verified: ['true'] });
	const page = toAgentRosterPage(
		connection([agentNode()], { hasNextPage: true, endCursor: 'cursor-9' })
	);
	const html = await renderComponent('src/lib/agents/AgentRoster.svelte', {
		page,
		failure: null,
		filters,
	});

	const next = /href="([^"]*after=cursor-9[^"]*)"/.exec(html)?.[1];
	assert.ok(next, 'a next-page link must be rendered when lesser reports another page');
	assert.match(next, /type=CURATOR/);
	assert.match(next, /q=weather/);
	assert.match(next, /verified=true/);
});

/* -------------------------------------------------------------------------
 * The swap seam
 * ---------------------------------------------------------------------- */

/** The interim pieces `AgentRoster.svelte` composes and greater M6a takes away. */
const INTERIM = ['AgentCard', 'AgentTrustBadge', 'AgentRosterFilters'];

/**
 * Everything outside the face that depends on an interim piece.
 *
 * IMPORTS, not mentions. A route is free to REFER to the interim pieces in a
 * comment — pointing at where the form lives is useful documentation — and an
 * earlier version of this check failed on exactly that, which is the same
 * prose-versus-code confusion `tests/vendored-runes.test.mjs` had to resolve.
 * What breaks the seam is a module depending on one, and that is an import.
 *
 * THE READING IS THE SHARED ONE (`../scripts/lib/module-imports.mjs`) and that is the
 * point. This probe used to carry its own line-anchored regex, which is the same
 * scan `tests/agents-mobile.test.mjs` carried and the same one round 3 of this
 * pull request's review compiled four legal files past — and round 4 compiled
 * two more past its replacement. Two probes asserting one property with two
 * copies of one defect is how the second copy survives the fix to the first, so
 * there is one reading, it is the Svelte and TypeScript compilers rather than a
 * pattern, and both probes regress the same forms against it.
 */
function interimImports(source, path) {
	const live = liveScript(path, source);
	const offenders = computedImports(live).map(
		(call) => `${path} → ${call.trim()} (a dependency no static read can name)`
	);
	for (const specifier of moduleSpecifiers(live))
		for (const name of INTERIM)
			if (modulePath(specifier).endsWith(`/${name}.svelte`))
				offenders.push(`${path} → ${specifier}`);
	return offenders;
}

test('nothing outside src/lib/agents imports the interim roster components', () => {
	// THE SEAM. greater M6a replaces `AgentRoster.svelte`'s body wholesale. That
	// is only a single-boundary swap while the interim pieces it composes are
	// reachable from nowhere else — otherwise the replacement leaves orphaned
	// imports in routes and the route has to change too.
	//
	// TRACKED source, not a directory listing — see `./helpers/tracked-source.mjs`.
	// Another test plants malformed fixtures inside `src/lib/compose` and removes
	// them, and a listing walk reads whatever is on disk when it happens to run.
	const seam = join(repoRoot, 'src', 'lib', 'agents');
	const offenders = trackedSource(repoRoot, 'src', MODULE_SOURCE)
		// The seam's own directory is where these are allowed to be used.
		.filter((path) => !path.startsWith(`${seam}/`))
		.flatMap((path) => interimImports(readFileSync(path, 'utf8'), path));

	assert.deepEqual(offenders, []);
});

test('the seam check can still see an import, in every form a comment can hide it', () => {
	// The guard above is only worth anything if it would fail, and the forms it has
	// to survive are the ones reviewers have actually compiled past it: round 3's
	// comments-where-whitespace-was-expected, and round 4's two harder ones — a
	// comment that MERGES `import` into the token beside it when it is stripped,
	// and a markup comment carrying a fake `<script>` opener.
	//
	// The specifiers resolve from this file, which CON-5 once required of every
	// gate file — its reader was raw text and a fixture that trips the gate it is
	// testing beside is not a fixture. It reads with the parser now, and the form
	// is kept as the convention it became.
	const target = '../src/lib/agents/AgentCard.svelte';
	const route = 'src/lib/routes/Agents.svelte';
	for (const body of [
		`import AgentCard from '${target}';`,
		`/* the card */ import AgentCard from '${target}';`,
		`import AgentCard from /* the card */ '${target}';`,
		`/* the card */ export { default as AgentCard } from '${target}';`,
		`export { default as AgentCard } from /* the card */ '${target}';`,
		`const a = 1; import AgentCard from '${target}';`,
		`import '${target}';`,
		// Round 4: the comment is the only separator, so removing it joins two
		// tokens into one word no pattern for `import` can match.
		`import/* the card */AgentCard from '${target}';`,
		`import AgentCard from/* the card */'${target}';`,
		`import/* the card */'${target}';`,
		`export/* the card */{ default as AgentCard } from '${target}';`,
		`export { default as AgentCard } from/* the card */'${target}';`,
		// And a type-only edge, which breaks on the swap exactly as a value does.
		`import type { Props } from '${target}';`,
	])
		assert.deepEqual(
			interimImports(`<script lang="ts">\n${body}\n</script>\n`, route),
			[`${route} → ${target}`],
			body
		);

	// Round 4's other half: markup shaped to steer a tag pattern away from the real
	// script. None of these is a script block to the compiler that compiles them.
	for (const disguise of [
		(b) => `<!-- <script> /* -->\n${b}`,
		(b) => `<!-- <script> -->\n${b}`,
		(b) => `<div data-snippet="<script>"></div>\n${b}`,
		(b) => `<!-- </script> -->\n${b}`,
		(b) => `${b}\n<p>{'<script>'}</p>`,
	])
		assert.deepEqual(
			interimImports(
				disguise(`<script lang="ts">\nimport AgentCard from '${target}';\n</script>\n`),
				route
			),
			[`${route} → ${target}`],
			disguise('')
		);

	// A computed import names nothing, so it is reported as unreadable rather than
	// waved through — the same fail-closed rule the whole-face check applies.
	assert.deepEqual(interimImports(`<script>const c = await import(where);</script>`, route), [
		`${route} → import(where) (a dependency no static read can name)`,
	]);

	// And prose is still prose, in either comment syntax and in markup.
	for (const prose of [
		`<script>// see ${target} for the card\n</script>`,
		`<script>/* import AgentCard from '${target}'; */</script>`,
		`<!-- import AgentCard from '${target}'; -->\n<p>see \`AgentCard.svelte\`</p>`,
	])
		assert.deepEqual(interimImports(prose, route), [], prose);
});

test('the seam check reads the markup, which is where round 5 hid a dependency', () => {
	// The reading returned a component's two `<script>` blocks and nothing else, so
	// a handler loading an interim piece was a dependency sitting in a region
	// neither seam check looked at. Each form is planted with the compiler's own
	// output as its witness, so it is a proven dependency before it is a caught one.
	//
	// THE WITNESS IS THE CLIENT BUILD. The server build drops event handlers and
	// would report no dependency for a file that has one — it agrees with the bug.
	const target = '../src/lib/agents/AgentCard.svelte';
	const route = 'src/lib/routes/Agents.svelte';

	for (const body of [
		`<button onclick={async () => { card = (await import('${target}')).default; }}>load</button>`,
		`<button onclick={() => import('${target}')}>load</button>`,
		`{#await import('${target}') then Card}<Card />{/await}`,
		`{#if ready}{@const card = import('${target}')}<p>{card}</p>{/if}`,
	]) {
		const source = `<script lang="ts">\n\tlet ready = $state(false);\n\tlet card = $state(null);\n</script>\n\n${body}\n`;
		assert.ok(
			compile(source, { generate: 'client', filename: 'Fixture.svelte' }).js.code.includes(target),
			`the build must take this dependency: ${body}`
		);
		assert.deepEqual(interimImports(source, route), [`${route} → ${target}`], body);
	}

	// A computed import in markup is as unreadable as one in a script, and reported.
	assert.deepEqual(interimImports(`<button onclick={() => import(where)}>load</button>`, route), [
		`${route} → import(where) (a dependency no static read can name)`,
	]);

	// And prose in markup is still prose — including an import CALL written as text,
	// which has no compile witness because markup is emitted as text either way.
	for (const prose of [`<p>{"import('${target}')"}</p>`, `<!-- import('${target}') -->`])
		assert.deepEqual(interimImports(prose, route), [], prose);
});

test('a query on a specifier does not hide the interim piece it addresses', () => {
	// `$lib/agents/AgentCard.svelte?raw` builds, and the match here was
	// `endsWith('/AgentCard.svelte')` against a string that ends in `?raw`. A query
	// crosses the seam: the bundler resolves the same path and reads the same file,
	// and what it alters is what the importer receives rather than which file the
	// swap replaces. `../scripts/lib/module-imports.mjs` carries the reasoning.
	//
	// The fixtures address the face as `$lib/…` rather than the `../src/…` used
	// above because CON-5 read a path with `?raw` on the end as a relative
	// specifier resolving to no file — the same defect, one gate over, since
	// repaired by pointing its reader at `modulePath` too.
	const route = 'src/lib/routes/Agents.svelte';

	for (const query of ['?raw', '?url', '?raw&inline', '#anchor']) {
		const specifier = `$lib/agents/AgentCard.svelte${query}`;
		assert.deepEqual(
			interimImports(
				`<script lang="ts">\nimport AgentCard from '${specifier}';\n</script>\n`,
				route
			),
			[`${route} → ${specifier}`],
			query
		);
	}

	// In markup as well, where both of round 5's other forms sit.
	assert.deepEqual(
		interimImports(
			`<button onclick={() => import('$lib/agents/AgentCard.svelte?raw')}>load</button>`,
			route
		),
		[`${route} → $lib/agents/AgentCard.svelte?raw`]
	);

	// A query on something that is not an interim piece is still not one.
	assert.deepEqual(
		interimImports(
			`<script lang="ts">\nimport css from '$lib/brand/agents.css?url';\n</script>\n`,
			route
		),
		[]
	);
});

test('the route imports the seam and not the pieces behind it', () => {
	const routeSource = readFileSync(join(repoRoot, 'src/lib/routes/Agents.svelte'), 'utf8');

	assert.match(routeSource, /AgentRoster\.svelte/);
	assert.ok(!routeSource.includes('AgentCard'), 'the route must not reach past the seam');
});

/* -------------------------------------------------------------------------
 * SSR: the server paints the gate, and nothing else
 * ---------------------------------------------------------------------- */

test('the server renders the session gate and asks lesser for nothing', async () => {
	// THE SHAPE THE ROUTE NOW HAS. lesser's GraphQL gateway refuses anonymous
	// `agents` operations with 401 BEFORE the resolver runs
	// (`anonymousGraphQLPublicQueryFields`, cmd/graphql/main.go), and the
	// session lives in sessionStorage where the server cannot read it. So the
	// server paints the gate the client replaces after reading the session,
	// and makes NO roster read: these props are serialized verbatim into the
	// public hydration endpoint, and a server-side read would both fail for
	// lack of a token and put an authenticated answer behind a public URL.
	//
	// The stub THROWS rather than answering, so a regression that reintroduces
	// a server-side roster read fails loudly instead of passing quietly with a
	// null-data roster.
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) => {
			throw new Error(`the server must not call lesser for the roster (${operation})`);
		},
		() => renderRoute(handler, route('agents'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Reading your session'), 'the gate is the server’s paint');
	assert.ok(
		!value.html.includes('Sign in to see this'),
		'the gate must not guess signed-out — that was the bug this redesign fixes'
	);
	assert.deepEqual(
		requests.filter((r) => r.operation.startsWith('ContentusAgent')),
		[],
		'no roster or detail read on the server pass'
	);
});

test('the filtered address renders the same gate, filters intact for the client', async () => {
	// The address grammar is all the server ships: `resolveAgentFilters` reads
	// it off the URL (asserted above), the client fetch asks for exactly that
	// page (asserted below), and the gate in between is identical.
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) => {
			throw new Error(`the server must not call lesser for the roster (${operation})`);
		},
		() => renderRoute(handler, route('agents-filtered'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Reading your session'));
	assert.deepEqual(requests, []);
});

/* -------------------------------------------------------------------------
 * The client read: what the session fetch sends and how it degrades
 * ---------------------------------------------------------------------- */

test('the client read sends the caller’s token and the address’s filters', async () => {
	const stub = stubbedFetch(() => ({ data: { agents: connection([agentNode()]) } }));
	try {
		const result = await fetchAgentRoster(
			{ endpoint: ROSTER_ENDPOINT, accessToken: 'token-ada' },
			{ type: 'CURATOR', query: 'weather', verified: true, after: 'cursor-8' }
		);

		assert.equal(result.ok, true);
		assert.equal(result.page.agents[0].username, 'weatherbot');

		assert.equal(stub.requests.length, 1);
		const [request] = stub.requests;
		assert.equal(request.url, ROSTER_ENDPOINT);
		assert.equal(request.operation, 'ContentusAgents');
		assert.equal(request.authorization, 'Bearer token-ada');
		assert.equal(request.variables.type, 'CURATOR');
		assert.equal(request.variables.query, 'weather');
		assert.equal(request.variables.verified, true);
		assert.equal(request.variables.after, 'cursor-8');
	} finally {
		stub.restore();
	}
});

test('an empty filtered page with more pages does not claim there are no matches', () => {
	// lesser filters each page AFTER reading it, so an empty page with
	// `hasNextPage` is "not on this page", not "none exist". The wording lives
	// in `emptyRosterMessage` with the filter model; the component renders it
	// verbatim.
	assert.equal(
		emptyRosterMessage({ agentCount: 0, filtered: true, hasNextPage: true }),
		'No agents on this page match these filters. This instance filters each page as it is read, so there may be matches further along.'
	);
	assert.equal(
		emptyRosterMessage({ agentCount: 0, filtered: true, hasNextPage: false }),
		'No agents match these filters.'
	);
	assert.equal(
		emptyRosterMessage({ agentCount: 0, filtered: false, hasNextPage: false }),
		'This instance has no agents to show.'
	);
	assert.equal(emptyRosterMessage({ agentCount: 2, filtered: true, hasNextPage: true }), null);
});

test('the component renders the contract’s empty message verbatim', async () => {
	const html = await renderComponent('src/lib/agents/AgentRoster.svelte', {
		page: toAgentRosterPage(connection([], { hasNextPage: true, endCursor: 'c9' })),
		failure: null,
		filters: resolveAgentFilters({ type: ['CURATOR'] }),
	});

	assert.ok(
		html.includes('there may be matches further along'),
		'lesser filters each page after reading it, and the empty state must say so'
	);
	assert.ok(
		!html.includes('No agents match these filters.'),
		'that claim is only true when there are no further pages'
	);
});

test('an instance with agents switched off says so rather than erroring', async () => {
	const stub = stubbedFetch(() => ({
		errors: [{ message: 'agents are disabled by instance policy' }],
	}));
	try {
		const result = await fetchAgentRoster({ endpoint: ROSTER_ENDPOINT, accessToken: 'token' });

		assert.equal(result.ok, false);
		assert.equal(result.failure.reason, 'agents-disabled');
		assert.ok(result.failure.message.includes('does not offer an agent surface'));
	} finally {
		stub.restore();
	}
});

test('malformed errors, HTTP failures, and empty data degrade to an explained failure', async () => {
	const cases = [
		['non-object error entries', { data: null, errors: [null, 42, 'broken'] }],
		['a non-GraphQL HTTP failure', { httpStatus: 503 }],
		[
			'a non-2xx GraphQL response',
			{ httpStatus: 503, data: null, errors: [{ message: 'internal server error' }] },
		],
		['an answer with no agents connection', { data: { agents: null } }],
	];

	for (const [name, envelope] of cases) {
		const stub = stubbedFetch(() => envelope);
		try {
			const result = await fetchAgentRoster({ endpoint: ROSTER_ENDPOINT, accessToken: 'token' });
			assert.equal(result.ok, false, `${name} must degrade, never throw`);
			assert.match(
				result.failure.message,
				/(?:could not|did not) answer the agent query/i,
				`${name} must explain the failure`
			);
		} finally {
			stub.restore();
		}
	}
});

test('a degenerate agents connection never throws', async () => {
	const stub = stubbedFetch(() => ({
		data: { agents: { edges: [null, 42, { node: null }], pageInfo: 'not-an-object' } },
	}));
	try {
		const result = await fetchAgentRoster({ endpoint: ROSTER_ENDPOINT, accessToken: 'token' });
		// Whether it reads as an empty page or a transport failure is lesser's
		// answer to make; the one thing it may not do is take the surface down.
		assert.ok(result.ok === true || result.ok === false);
		if (result.ok) assert.deepEqual(result.page.agents, []);
	} finally {
		stub.restore();
	}
});
