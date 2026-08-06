#!/usr/bin/env node
/**
 * LIVE CONTRACT PROBE — the documents contentus really sends, against a real
 * lesser instance.
 *
 * WHY THIS EXISTS. `scripts/audit-graphql-contract.mjs` proves the documents match
 * the schema this repository pinned. That is a statement about a file. It cannot
 * tell you whether a running instance accepts them, and the milestone's acceptance
 * contract asks exactly that. Adversarial review found the repository asserting
 * that no instance was reachable while one was — a claim that had gone stale
 * without anyone re-running it. A one-command probe is the repair: the claim is
 * cheap to re-check, so it stops being something anybody has to take on trust.
 *
 * THE DOCUMENTS ARE IMPORTED, NOT RETYPED. `src/lib/cms/queries.ts` is the source,
 * so a probe cannot drift from what the app sends — which is the same defect, in
 * the same shape, as the fixtures that agreed with the wrong query.
 *
 *   node --experimental-strip-types scripts/probe-live-contract.mjs \
 *     --base https://dev.trenchcoat.greater.website
 *
 * READ-ONLY AND ANONYMOUS BY DEFAULT. Only queries are sent; there is no mutation
 * in this file and no code path that writes. Nothing is deployed and no cloud or
 * runtime state is touched.
 *
 * CREDENTIALS. Anonymous needs none. The authenticated half of the acceptance
 * contract is the OPERATOR's to run, so a token is read only from
 * `CONTENTUS_PROBE_TOKEN` in the environment — never a flag, because a flag lands
 * in shell history and process listings. It is sent as a bearer header and is
 * never printed, written, or included in any output this script produces; the
 * report states only WHETHER a token was present. Do not commit output containing
 * one, and there is no path here that could put one there.
 */
import {
	ARTICLES_INDEX_QUERY,
	ARTICLE_BY_SLUG_QUERY,
	ARTICLE_NAVIGATION_QUERY,
} from '../src/lib/cms/queries.ts';

const GRAPHQL_PATH = '/api/graphql';

function baseFrom(argv) {
	const index = argv.indexOf('--base');
	const value = index === -1 ? null : argv[index + 1];
	if (!value) {
		process.stderr.write(
			'probe-live-contract: --base <https://instance> is required\n' +
				'  example: --base https://dev.trenchcoat.greater.website\n'
		);
		process.exit(1);
	}
	let url;
	try {
		url = new URL(value);
	} catch {
		process.stderr.write(`probe-live-contract: ${value} is not a URL\n`);
		process.exit(1);
	}
	if (url.protocol !== 'https:') {
		// A token, when the operator supplies one, must never leave over plaintext.
		process.stderr.write('probe-live-contract: only https bases are accepted\n');
		process.exit(1);
	}
	return url.origin;
}

/** POST one document. Returns status and parsed body; never returns the token. */
async function ask(endpoint, token, name, query, variables = {}) {
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};

	let response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify({ query, variables }),
		});
	} catch (error) {
		return { name, ok: false, status: null, error: error?.message ?? String(error) };
	}

	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		return { name, ok: false, status: response.status, error: 'response was not JSON' };
	}
	return {
		name,
		ok: response.ok && !body.errors?.length,
		status: response.status,
		errors: (body.errors ?? []).map((error) => error.message),
		data: body.data ?? null,
	};
}

function report(result) {
	const mark = result.ok ? 'PASS' : 'FAIL';
	process.stdout.write(`  [${mark}] ${result.name} — HTTP ${result.status ?? 'no response'}\n`);
	if (result.error) process.stdout.write(`         ${result.error}\n`);
	for (const message of result.errors ?? []) process.stdout.write(`         ${message}\n`);
}

async function main(argv) {
	const base = baseFrom(argv);
	const endpoint = `${base}${GRAPHQL_PATH}`;
	// Read from the environment only, and never echoed below.
	const token = process.env.CONTENTUS_PROBE_TOKEN || null;

	process.stdout.write(`probe-live-contract: ${endpoint}\n`);
	process.stdout.write(
		`probe-live-contract: ${token ? 'AUTHENTICATED (token from CONTENTUS_PROBE_TOKEN)' : 'ANONYMOUS (no credential)'}\n\n`
	);

	const results = [];

	const index = await ask(
		endpoint,
		token,
		'articles index (ARTICLES_INDEX_QUERY)',
		ARTICLES_INDEX_QUERY,
		{ first: 3 }
	);
	results.push(index);
	report(index);

	const edges = index.data?.articles?.edges ?? [];
	process.stdout.write(`         totalCount ${index.data?.articles?.totalCount ?? 'n/a'}\n`);
	for (const edge of edges) {
		const node = edge?.node ?? {};
		// `avatar` is the field this milestone corrected. Printing what the instance
		// answered for it is the point of the probe, null included: a null value is
		// the actor having no avatar, which is different from the field not existing.
		process.stdout.write(
			`         ${node.slug} — author ${node.author?.username ?? '?'}, avatar ${JSON.stringify(node.author?.avatar ?? null)}\n`
		);
	}

	const navigation = await ask(
		endpoint,
		token,
		'categories (ARTICLE_NAVIGATION_QUERY)',
		ARTICLE_NAVIGATION_QUERY
	);
	results.push(navigation);
	report(navigation);

	const slug = edges[0]?.node?.slug ?? null;
	if (slug) {
		const detail = await ask(
			endpoint,
			token,
			`articleBySlug (ARTICLE_BY_SLUG_QUERY) — ${slug}`,
			ARTICLE_BY_SLUG_QUERY,
			{ slug }
		);
		results.push(detail);
		report(detail);
		const article = detail.data?.articleBySlug ?? null;
		if (article) {
			process.stdout.write(
				`         contentFormat ${article.contentFormat}, ${String(article.content ?? '').length} bytes of content, ` +
					`author avatar ${JSON.stringify(article.author?.avatar ?? null)}\n`
			);
		}
	} else {
		process.stdout.write('  [SKIP] articleBySlug — the index returned no slug to ask for\n');
	}

	// THE NEGATIVE CONTROL. Without it a green run proves only that the endpoint
	// answers, not that it adjudicates: `avatarUrl` is the exact field this
	// milestone removed, and the instance must still refuse it.
	const control = await ask(
		endpoint,
		token,
		'NEGATIVE CONTROL — Actor.avatarUrl must be refused',
		'query ContentusAvatarUrlControl { articles(first: 1) { edges { node { id author { id avatarUrl } } } } }'
	);
	const refused = control.errors?.some((message) => /avatarUrl/.test(message)) ?? false;
	process.stdout.write(
		`  [${refused ? 'PASS' : 'FAIL'}] ${control.name} — HTTP ${control.status ?? 'no response'}\n`
	);
	for (const message of control.errors ?? []) process.stdout.write(`         ${message}\n`);
	if (!refused) {
		process.stdout.write(
			'         the instance did NOT reject avatarUrl; this probe proves nothing about the contract\n'
		);
	}

	const failed = results.filter((result) => !result.ok).length;
	process.stdout.write(
		`\nprobe-live-contract: ${results.length - failed}/${results.length} documents accepted; ` +
			`negative control ${refused ? 'refused as required' : 'DID NOT BITE'}\n`
	);
	return failed === 0 && refused ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
