#!/usr/bin/env node
/**
 * LIVE CONTRACT PROBE — the documents contentus really sends, against a real
 * lesser instance.
 *
 * WHY THIS EXISTS. `pnpm run validate:graphql` proves the documents match the
 * schema this repository pinned. That is a statement about a file. It cannot
 * tell you whether a running instance accepts them, and the milestone's acceptance
 * contract asks exactly that.
 *
 * THE DOCUMENTS ARE IMPORTED, NOT RETYPED. `src/lib/cms/queries.ts` is the source,
 * so a probe cannot drift from what the app sends — which is the same defect, in
 * the same shape, as the fixtures that agreed with the wrong query.
 *
 *   node --experimental-strip-types scripts/probe-live-contract.mjs \
 *     --base https://dev.trenchcoat.greater.website
 *
 * ── A TOKEN BEING PRESENT IS NOT AUTHENTICATION ─────────────────────────────
 *
 * The previous version printed `AUTHENTICATED` whenever `CONTENTUS_PROBE_TOKEN`
 * was set. Adversarial review ran it with `CONTENTUS_PROBE_TOKEN=codex-review-
 * intentionally-invalid`: it printed AUTHENTICATED, passed all three public CMS
 * documents, and exited 0. Every one of those reads is PUBLIC, and lesser's own
 * auth tests establish that an invalid bearer may simply be treated as anonymous —
 * so the probe was reporting the presence of an environment variable as if it were
 * a property of the session. That is not a weaker claim than intended; it is a
 * different claim, and it is false.
 *
 * WHAT REPLACES IT. In token mode the probe first executes a QUERY-ONLY protected
 * identity read — `viewer { id username }` — which lesser resolves through
 * `requireAuth` and refuses with `authentication required` for anonymous or
 * invalid callers (`graph/query_resolvers_accounts.go`, `graph/errors.go`). This
 * is Simulacrum's fail-closed pattern (`src/lib/api/index.ts#fetchViewer`), which
 * requires a token and treats any GraphQL error as a thrown failure rather than as
 * a null session. A nonempty `id` AND `username`, with no errors, is the only
 * thing that earns the word AUTHENTICATED. Anything else exits non-zero BEFORE any
 * public document is read, so an invalid token can never be laundered into a green
 * run by public data.
 *
 * NO SKIP-TO-GREEN. The detail document is required, not conditional on the index
 * happening to return a slug. An index with no articles is a probe that proved less
 * than it claimed, and it now says so with a non-zero exit.
 *
 * ── THE TOKEN NEVER LEAVES ──────────────────────────────────────────────────
 *
 * It is read only from `CONTENTUS_PROBE_TOKEN` — never a flag, because a flag lands
 * in shell history and process listings — and sent as a bearer header. EVERY byte
 * this script writes goes through `redacting`, because the paths that could carry
 * it back are not all ours: a hostile or merely careless instance can echo a bearer
 * into a GraphQL error message, and `fetch` can put a URL into an exception. The
 * writer redacts, and then ASSERTS the result is clean and aborts if it is not, so
 * a redaction that missed an encoding fails loudly instead of printing a
 * credential.
 *
 * READ-ONLY THROUGHOUT. Only queries are sent; there is no mutation in this file
 * and no code path that writes. Nothing is deployed and no cloud or runtime state
 * is touched.
 */
import {
	ARTICLES_INDEX_QUERY,
	ARTICLE_BY_SLUG_QUERY,
	ARTICLE_NAVIGATION_QUERY,
} from '../src/lib/cms/queries.ts';

const GRAPHQL_PATH = '/api/graphql';

/**
 * The protected identity read, and the reason it is spelled here rather than
 * imported.
 *
 * It is not a document the application sends — it is the probe asking lesser who
 * it is talking to. `tests/live-probe.test.mjs` validates it against the SAME
 * pinned lesser schema the contract gate uses, so it cannot drift from the
 * contract even though it has no in-app call site. That is a stronger control than
 * importing it would be: importing proves two files agree, validating proves the
 * document is one lesser accepts.
 *
 * `viewer` resolves through lesser's `requireAuth`. Anonymous and invalid callers
 * get `authentication required` rather than a null viewer, which is what makes a
 * clean answer here evidence rather than a formality.
 */
export const VIEWER_IDENTITY_QUERY = `
query ContentusProbeViewerIdentity {
	viewer {
		id
		username
	}
}
`;

/**
 * A writer that cannot emit the credential.
 *
 * Redacts every spelling of the token this script could plausibly meet — raw,
 * percent-encoded, and base64 — and then CHECKS its own work. A redactor that
 * silently missed an encoding would be worse than none, because the output would
 * carry the reassurance of having been redacted.
 */
export function redacting(write, token) {
	const spellings = token
		? [...new Set([token, encodeURIComponent(token), Buffer.from(token).toString('base64')])]
				.filter(Boolean)
				.sort((a, b) => b.length - a.length)
		: [];

	return (text) => {
		let out = String(text);
		for (const spelling of spellings) out = out.split(spelling).join('«redacted»');
		if (token && out.includes(token)) {
			// Never print the offending text — not even to explain itself.
			process.stderr.write(
				'\nprobe-live-contract: ABORTING — output still contained the credential after ' +
					'redaction. This is a bug in the redactor, and printing anything further would ' +
					'leak the token.\n'
			);
			process.exit(2);
		}
		write(out);
	};
}

function baseFrom(argv, fail) {
	const index = argv.indexOf('--base');
	const value = index === -1 ? null : argv[index + 1];
	if (!value) {
		return fail(
			'probe-live-contract: --base <https://instance> is required\n' +
				'  example: --base https://dev.trenchcoat.greater.website\n'
		);
	}
	let url;
	try {
		url = new URL(value);
	} catch {
		return fail(`probe-live-contract: ${value} is not a URL\n`);
	}
	if (url.protocol !== 'https:') {
		// A token, when the operator supplies one, must never leave over plaintext.
		return fail('probe-live-contract: only https bases are accepted\n');
	}
	return url.origin;
}

/** POST one document. Returns status and parsed body; never returns the token. */
async function ask(fetchImpl, endpoint, token, name, query, variables = {}) {
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};

	let response;
	try {
		response = await fetchImpl(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify({ query, variables }),
		});
	} catch (error) {
		// An exception message is server- and runtime-influenced text like any other,
		// so it goes to the redacting writer rather than straight to stdout.
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
		errors: (body.errors ?? []).map((error) => error?.message ?? String(error)),
		data: body.data ?? null,
	};
}

function reporter(say) {
	return (result) => {
		const mark = result.ok ? 'PASS' : 'FAIL';
		say(`  [${mark}] ${result.name} — HTTP ${result.status ?? 'no response'}\n`);
		if (result.error) say(`         ${result.error}\n`);
		for (const message of result.errors ?? []) say(`         ${message}\n`);
	};
}

/** A nonempty string, which is what "an identity" means here. */
const identity = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

export async function main(
	argv,
	{
		fetchImpl = globalThis.fetch,
		env = process.env,
		write = (text) => process.stdout.write(text),
	} = {}
) {
	// Read from the environment only. Bound before anything can be written, so the
	// redactor is in place for every line below including the failure paths.
	const token = env.CONTENTUS_PROBE_TOKEN || null;
	const say = redacting(write, token);

	let failed = false;
	const base = baseFrom(argv, (message) => {
		say(message);
		failed = true;
		return null;
	});
	if (failed || !base) return 1;

	const endpoint = `${base}${GRAPHQL_PATH}`;
	const report = reporter(say);
	say(`probe-live-contract: ${endpoint}\n`);

	// The identity read is counted in the tally alongside the CMS documents. It is
	// a document the probe sent and required to pass, so leaving it out would make
	// the printed count describe less work than was actually gated.
	const results = [];

	// --- token mode: prove the session before claiming it --------------------
	if (token) {
		const viewer = await ask(
			fetchImpl,
			endpoint,
			token,
			'protected identity (viewer { id username })',
			VIEWER_IDENTITY_QUERY
		);
		report(viewer);

		const id = identity(viewer.data?.viewer?.id);
		const username = identity(viewer.data?.viewer?.username);
		if (!viewer.ok || !id || !username) {
			say(
				'\nprobe-live-contract: NOT AUTHENTICATED — a token was supplied and lesser did not\n' +
					'  answer with an identity for it. `viewer` requires authentication, so an anonymous\n' +
					'  or rejected session lands here. The public article reads below would have\n' +
					'  succeeded anyway, which is exactly why they cannot be the evidence.\n'
			);
			return 1;
		}
		results.push(viewer);
		say(`probe-live-contract: AUTHENTICATED as ${username} (${id})\n\n`);
	} else {
		say('probe-live-contract: ANONYMOUS (no credential)\n\n');
	}

	const index = await ask(
		fetchImpl,
		endpoint,
		token,
		'articles index (ARTICLES_INDEX_QUERY)',
		ARTICLES_INDEX_QUERY,
		{ first: 3 }
	);
	results.push(index);
	report(index);

	const edges = index.data?.articles?.edges ?? [];
	say(`         totalCount ${index.data?.articles?.totalCount ?? 'n/a'}\n`);
	for (const edge of edges) {
		const node = edge?.node ?? {};
		// `avatar` is the field this milestone corrected. Printing what the instance
		// answered for it is the point of the probe, null included: a null value is
		// the actor having no avatar, which is different from the field not existing.
		say(
			`         ${node.slug} — author ${node.author?.username ?? '?'}, avatar ${JSON.stringify(node.author?.avatar ?? null)}\n`
		);
	}

	const navigation = await ask(
		fetchImpl,
		endpoint,
		token,
		'categories (ARTICLE_NAVIGATION_QUERY)',
		ARTICLE_NAVIGATION_QUERY
	);
	results.push(navigation);
	report(navigation);

	// THE DETAIL DOCUMENT IS REQUIRED. It used to be skipped when the index
	// returned nothing, and a skipped document read as a pass — a probe that
	// checked two of three documents while reporting on all three. An instance
	// with no articles has not demonstrated the detail contract, and saying so is
	// the only honest outcome.
	const slug = identity(edges[0]?.node?.slug);
	if (!slug) {
		say(
			'  [FAIL] articleBySlug (ARTICLE_BY_SLUG_QUERY) — the index returned no slug to ask for\n' +
				'         The detail document is part of the acceptance contract, so an index that\n' +
				'         yields nothing to ask about is an incomplete probe rather than a pass.\n'
		);
		results.push({ name: 'articleBySlug (ARTICLE_BY_SLUG_QUERY)', ok: false, status: null });
	} else {
		const detail = await ask(
			fetchImpl,
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
			say(
				`         contentFormat ${article.contentFormat}, ${String(article.content ?? '').length} bytes of content, ` +
					`author avatar ${JSON.stringify(article.author?.avatar ?? null)}\n`
			);
		}
	}

	// THE NEGATIVE CONTROL. Without it a green run proves only that the endpoint
	// answers, not that it adjudicates: `avatarUrl` is the exact field this
	// milestone removed, and the instance must still refuse it.
	const control = await ask(
		fetchImpl,
		endpoint,
		token,
		'NEGATIVE CONTROL — Actor.avatarUrl must be refused',
		'query ContentusAvatarUrlControl { articles(first: 1) { edges { node { id author { id avatarUrl } } } } }'
	);
	const refused = control.errors?.some((message) => /avatarUrl/.test(message)) ?? false;
	say(
		`  [${refused ? 'PASS' : 'FAIL'}] ${control.name} — HTTP ${control.status ?? 'no response'}\n`
	);
	for (const message of control.errors ?? []) say(`         ${message}\n`);
	if (!refused) {
		say(
			'         the instance did NOT reject avatarUrl; this probe proves nothing about the contract\n'
		);
	}

	const failures = results.filter((result) => !result.ok).length;
	say(
		`\nprobe-live-contract: ${results.length - failures}/${results.length} documents accepted; ` +
			`negative control ${refused ? 'refused as required' : 'DID NOT BITE'}` +
			`${token ? '; authenticated session verified by protected identity read' : ''}\n`
	);
	return failures === 0 && refused ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv.slice(2)));
}
