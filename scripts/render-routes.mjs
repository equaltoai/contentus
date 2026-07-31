#!/usr/bin/env node

/**
 * Drive the built SSR handler over every route and return what it actually
 * emitted.
 *
 * Contentus renders per request, so there is no static artifact to inspect the
 * way an SSG build leaves one behind. Auditing source instead would be weaker
 * evidence: what ships is what this handler produces, including whatever the
 * vendored components emit. So the audits import `build/server/handler.mjs`
 * and exercise it exactly as lesser's SSR host does.
 *
 * This doubles as the SSR-every-route smoke test: lesser performs no SPA
 * fallback under `/l/*`, so a route that fails here is a hard error page on the
 * instance, not a soft miss.
 *
 * The instance is not reachable from the build host, so by default every GraphQL
 * fetch fails and each route renders its designed unavailable state. That is the
 * intended audit surface: it proves the degraded path is CSP-clean and
 * renders, which is the path a cold or misconfigured instance actually shows.
 *
 * The degraded path is not the whole surface, though. `withStubbedGraphql`
 * drives the same built handler with CONTROLLED GraphQL responses, so the
 * loaded-body branches — the ones a real instance actually serves — are
 * exercised against the built artifact too, and the requests the server makes
 * are recorded rather than inferred. `pnpm dev` behaviour is not evidence about
 * what ships; this is.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const handlerPath = resolve(repoRoot, 'build/server/handler.mjs');

/**
 * Routes exercised by the audits. `/l` prefixes are included because that is
 * what lesser's SSR host forwards, so the base-path stripping is covered too.
 */
export const AUDIT_ROUTES = [
	{ name: 'articles-index', path: '/l/', expectStatus: 200 },
	{ name: 'article-reader', path: '/l/articles/example-article', expectStatus: 200 },
	{ name: 'series', path: '/l/series/example-series', expectStatus: 200 },
	{ name: 'category', path: '/l/categories/example-category', expectStatus: 200 },
	// Authenticated in effect, anonymous on the server: the session lives in
	// sessionStorage, so the SSR pass renders the page and its sign-in state and
	// no write control at all. A 200 here is the designed answer — the route
	// exists for everyone, the composer does not.
	{ name: 'compose', path: '/l/compose', expectStatus: 200 },
	// Face 2, and the same shape as compose for the same reason: the route
	// exists for everyone and server-renders its sign-in state, while the queue
	// itself — which needs a bearer token — does not appear in the document at
	// all. The 200 is the designed answer; what makes it correct is asserted in
	// `tests/ssr-review.test.mjs`, which checks the anonymous document carries
	// no draft data and makes no authenticated fetch.
	{ name: 'review-queue', path: '/l/review', expectStatus: 200 },
	// The workspace, deep-linked cold. A draft is never public, so the 200 here
	// is the sign-in state — and the probe that matters is that the document
	// contains no draft at all, which `tests/ssr-review.test.mjs` asserts.
	{ name: 'review-workspace', path: '/l/review/drafts/draft-123', expectStatus: 200 },
	// Face 4. Unlike compose and review, these are genuinely anonymous READS:
	// lesser answers LOCAL, PUBLIC and ACTOR without a token, so a 200 here is a
	// real timeline for a real visitor rather than a sign-in shell. The
	// degraded rendering these produce against an unreachable instance is the
	// designed unavailable state, which is exactly what the audits should see.
	{ name: 'timelines-instance', path: '/l/timelines', expectStatus: 200 },
	{ name: 'timelines-federated', path: '/l/timelines?tab=federated', expectStatus: 200 },
	// The auth-gated tab, deep-linked cold and anonymously. Still a 200: the
	// route exists for everyone and server-renders its sign-in state, and
	// `tests/ssr-timelines.test.mjs` asserts the document carries no timeline
	// data and that the server made no authenticated fetch for it.
	{ name: 'timelines-home', path: '/l/timelines?tab=home', expectStatus: 200 },
	{ name: 'profile', path: '/l/profiles/ada', expectStatus: 200 },
	{ name: 'auth-callback', path: '/l/auth/callback', expectStatus: 200 },
	{ name: 'not-found', path: '/l/no-such-surface', expectStatus: 404 },
	{ name: 'hydration-data', path: '/l/_facetheory/hydration', expectStatus: 200 },
];

/**
 * A representative request as lesser's edge actually delivers it: CloudFront's
 * frontend function injects the verified viewer host as `x-lesser-forwarded-host`
 * and pins the proto (`lesser` → `infra/cdk/stacks/lesser_api_stack.go`). No
 * instance domain is baked into source.
 */
const AUDIT_HOST = 'contentus-audit.invalid';
const AUDIT_HEADERS = {
	host: AUDIT_HOST,
	'x-lesser-forwarded-host': AUDIT_HOST,
	'x-lesser-forwarded-proto': 'https',
};

export async function loadHandler() {
	if (!existsSync(handlerPath)) {
		throw new Error(
			'build/server/handler.mjs is missing; run `pnpm run build:client && pnpm run build:server` first.'
		);
	}
	const module = await import(pathToFileURL(handlerPath).href);
	if (typeof module.handler !== 'function') {
		throw new Error('build/server/handler.mjs does not export `handler`.');
	}
	return module.handler;
}

function decodeBody(result) {
	if (typeof result?.body !== 'string') return '';
	return result.isBase64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
}

function normalizeHeaders(result) {
	const headers = {};
	for (const [name, value] of Object.entries(result?.headers ?? {})) {
		headers[name.toLowerCase()] = value;
	}
	return headers;
}

/**
 * Render one route and return `{ status, headers, html }`.
 *
 * `route.headers`, when present, REPLACES the audit defaults rather than merging
 * into them: a probe that asserts which header the server trusts has to control
 * the whole header bag, or a default would quietly supply the answer.
 */
export async function renderRoute(handler, route) {
	const [path, rawQueryString = ''] = route.path.split('?');

	const result = await handler({
		rawPath: path,
		rawQueryString,
		headers: route.headers ?? AUDIT_HEADERS,
		requestContext: { http: { method: 'GET', path } },
	});

	return {
		name: route.name,
		path: route.path,
		expectStatus: route.expectStatus,
		status: result?.statusCode ?? 0,
		headers: normalizeHeaders(result),
		html: decodeBody(result),
	};
}

/**
 * Run `body` with `fetch` replaced by a GraphQL stub, and return
 * `{ value, requests }` — what `body` produced, and every request the built
 * handler made while producing it.
 *
 * `respond({ operation, variables })` returns the GraphQL envelope for one
 * operation — `{ data }`, `{ errors }`, or both. Returning nothing yields
 * `{ data: null }`, which is what an operation the probe does not care about
 * should look like.
 *
 * Recording `url` is the point as much as the responses are: it is the only
 * direct evidence of which host the SERVER chose to fetch from, which is exactly
 * the question a spoofed forwarding header raises.
 *
 * `authorization` is recorded for the same reason and read the same way the
 * runtime would: through `Headers`, so a `Authorization`/`authorization` case
 * difference or a `Headers` instance rather than a plain object cannot make an
 * assertion pass by reading a field that was never populated. Only that one
 * header is kept — a probe asserting on the whole bag would be asserting on the
 * transport's defaults rather than on what the server chose to send.
 */
export async function withStubbedGraphql(respond, body) {
	const requests = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : String(input?.url ?? input);
		const payload = init.body ? JSON.parse(init.body) : {};
		const operation = /query\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '';
		const variables = payload.variables ?? {};
		const authorization = new Headers(init.headers).get('authorization');

		requests.push({ url, operation, variables, authorization });

		const envelope = respond({ operation, variables }) ?? { data: null };
		return new Response(JSON.stringify(envelope), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	try {
		return { value: await body(), requests };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

/** Render every audited route. */
export async function renderAllRoutes() {
	const handler = await loadHandler();
	const rendered = [];
	for (const route of AUDIT_ROUTES) {
		rendered.push(await renderRoute(handler, route));
	}
	return rendered;
}
