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
 * The instance is not reachable from the build host, so every GraphQL fetch
 * fails and each route renders its designed unavailable state. That is the
 * intended audit surface: it proves the degraded path is CSP-clean and
 * renders, which is the path a cold or misconfigured instance actually shows.
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
	{ name: 'auth-callback', path: '/l/auth/callback', expectStatus: 200 },
	{ name: 'not-found', path: '/l/no-such-surface', expectStatus: 404 },
	{ name: 'hydration-data', path: '/l/_facetheory/hydration', expectStatus: 200 },
];

/** A representative host header; no instance domain is baked into source. */
const AUDIT_HOST = 'contentus-audit.invalid';

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

/** Render one route and return `{ status, headers, html }`. */
export async function renderRoute(handler, route) {
	const [path, rawQueryString = ''] = route.path.split('?');

	const result = await handler({
		rawPath: path,
		rawQueryString,
		headers: {
			host: AUDIT_HOST,
			'x-forwarded-proto': 'https',
		},
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

/** Render every audited route. */
export async function renderAllRoutes() {
	const handler = await loadHandler();
	const rendered = [];
	for (const route of AUDIT_ROUTES) {
		rendered.push(await renderRoute(handler, route));
	}
	return rendered;
}
