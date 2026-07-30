import { readFile } from 'node:fs/promises';

import {
	buildStrictCspHeader,
	createFaceApp,
	externalHydrationForEntry,
	handleLambdaUrlEvent,
	type FaceHeadTag,
	type LambdaUrlEvent,
	type Query,
	type ViteManifest,
	viteAssetsForEntry,
} from '@theory-cloud/facetheory';
import { createSvelteFace } from '@theory-cloud/facetheory/svelte';

import {
	canonicalArticleUrl,
	graphqlEndpointForOrigin,
	resolveRequestOrigin,
} from '$lib/cms/origin';
import { loadArticleBySlug, loadArticlesIndex, loadFilteredIndex } from '$lib/cms/loaders';
import { CLIENT_ASSET_BASE, HYDRATION_DATA_PATH } from '$lib/config/base-path';

import App from './App.svelte';
import { queryFromSearchString } from './query-parser';
import { ROUTE_PATTERNS, resolvePage, resolveSlug, statusForPage, stripBasePath } from './routing';
import type { RouteProps } from './types';

const CLIENT_ENTRY = 'src/facetheory/entry-client.ts';
const PUBLIC_HYDRATION_DATA_PATH = `/l${HYDRATION_DATA_PATH}`;
const SITE_STYLESHEET_HREF = `${CLIENT_ASSET_BASE}brand/contentus.css`;

/**
 * Strict CSP, applied to every SSR response.
 *
 * lesser does not inject a CSP on `/l` routes — the origin owns it
 * (`CLIENT_APP_GUIDE.md` → "Routing model"). `inlineScripts: false` and
 * `inlineStyles: false` are what force hydration data out of the document and
 * into the external JSON endpoint below.
 */
const STRICT_CSP = {
	inlineScripts: false,
	inlineStyles: false,
	rawHead: false,
} as const;

const manifestPromise = loadClientManifest();

async function loadClientManifest(): Promise<ViteManifest> {
	const manifestUrl = new URL('./client-manifest.json', import.meta.url);
	return JSON.parse(await readFile(manifestUrl, 'utf8')) as ViteManifest;
}

type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Build the props for a route.
 *
 * Every route server-renders its own data: lesser performs no SPA fallback
 * under `/l/*`, so a deep link arriving cold must produce a complete page. No
 * loader throws — each returns a designed state instead — so a slow or
 * unavailable instance degrades to an explained page rather than a 500.
 */
async function createRouteProps(path: string, headers: HeaderBag | undefined): Promise<RouteProps> {
	const page = resolvePage(path);
	const slug = resolveSlug(path);
	const endpoint = graphqlEndpointForOrigin(resolveRequestOrigin(headers));
	const ctx = { endpoint };

	const base: RouteProps = { page, slug, index: null, reader: null };

	switch (page.key) {
		case 'articles-index':
			return { ...base, index: await loadArticlesIndex(ctx) };
		case 'series':
			return { ...base, index: await loadFilteredIndex(ctx, 'series', slug ?? '') };
		case 'category':
			return { ...base, index: await loadFilteredIndex(ctx, 'category', slug ?? '') };
		case 'article-reader':
			return { ...base, reader: await loadArticleBySlug(ctx, slug ?? '') };
		default:
			// auth-callback and not-found render without server data: the former
			// needs sessionStorage, the latter has nothing to fetch.
			return base;
	}
}

function queryToSearchString(query?: Query): string {
	const params = new URLSearchParams();
	for (const key of Object.keys(query ?? {}).sort()) {
		for (const value of query?.[key] ?? []) params.append(key, value);
	}
	return params.toString();
}

function hydrationDataUrlForRequest(path: string, query?: Query): string {
	const params = new URLSearchParams();
	params.set('path', path || '/');
	const search = queryToSearchString(query);
	if (search) params.set('search', search);
	return `${PUBLIC_HYDRATION_DATA_PATH}?${params.toString()}`;
}

/**
 * The form of a canonical URL that FaceTheory's strict CSP will accept in a
 * `<link href>`, or null if there is none.
 *
 * FaceTheory validates every head `<link href>` under strict CSP as
 * same-origin-or-relative, and resolves "same origin" against an `allowedOrigin`
 * that `FaceApp` never forwards from the face (`dist/app.js` calls
 * `renderFaceHead(out, { cspNonce })` and nothing else). With no allowedOrigin
 * the only accepted shape is a relative URL, so an ABSOLUTE href throws — even
 * the page's own origin — and takes the whole route to a 500. That is what the
 * loaded-article path was hitting before the reader ever ran.
 *
 * So the link carries the same-origin identity in its relative form, which
 * resolves byte-identically against the document base: contentus is not
 * rewriting lesser's Article identity, it is spelling it the only way the
 * framework permits. A genuinely cross-origin canonical (a syndicated
 * `article.canonicalUrl`) cannot be expressed relatively and gets no link tag at
 * all — `og:url` still carries the absolute identity, since meta content is not
 * subject to this check.
 *
 * Sunset: delete this and emit the absolute href once FaceTheory forwards a
 * per-request allowedOrigin into `renderFaceHead`. Reported to the FaceTheory
 * steward; see docs/consumption/renderer-authority.md.
 */
function canonicalLinkHref(canonical: string | null, origin: string | null): string | null {
	if (!canonical || !origin) return null;
	try {
		const url = new URL(canonical);
		if (url.origin !== new URL(origin).origin) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}

/** Head tags derived from the loaded route: title, description, OG, canonical. */
function headTagsForRoute(props: RouteProps, origin: string | null) {
	const article = props.reader?.article ?? null;

	const title = article ? `${article.title} · Contentus` : `${props.page.title} · Contentus`;
	const description =
		article?.seoDescription ?? article?.excerpt ?? article?.subtitle ?? props.page.summary;

	// Canonical is lesser's Article identity (`https://<domain>/articles/<slug>`),
	// not the contentus reading route. That identity is what federates, and it is
	// lesser's to define — contentus points at it and never rewrites it. An
	// article that already carries an explicit canonicalUrl wins outright.
	const canonical = article
		? (article.canonicalUrl ?? canonicalArticleUrl(origin, article.slug))
		: null;

	const tags: FaceHeadTag[] = [
		{ type: 'meta', attrs: { charset: 'utf-8' } },
		{
			type: 'meta',
			attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' },
		},
		{ type: 'meta', attrs: { name: 'description', content: description } },
		{ type: 'meta', attrs: { property: 'og:title', content: title } },
		{ type: 'meta', attrs: { property: 'og:description', content: description } },
		{ type: 'meta', attrs: { property: 'og:type', content: article ? 'article' : 'website' } },
		{ type: 'link', attrs: { rel: 'stylesheet', href: SITE_STYLESHEET_HREF } },
		{ type: 'link', attrs: { rel: 'icon', href: `${CLIENT_ASSET_BASE}brand/icon.svg` } },
	];

	if (canonical) {
		tags.push({ type: 'meta', attrs: { property: 'og:url', content: canonical } });

		const canonicalHref = canonicalLinkHref(canonical, origin);
		if (canonicalHref) {
			tags.push({ type: 'link', attrs: { rel: 'canonical', href: canonicalHref } });
		}
	}
	if (article?.ogImage) {
		tags.push({ type: 'meta', attrs: { property: 'og:image', content: article.ogImage } });
	}

	return { title, tags };
}

function createFaceForRoute(route: string) {
	return createSvelteFace({
		route,
		mode: 'ssr',
		load: async (ctx) => createRouteProps(ctx.request.path, ctx.request.headers as HeaderBag),
		// FaceTheory types component props as an open `Record<string, unknown>`;
		// `RouteProps` is a closed interface, so it needs a widening cast here.
		// App.svelte re-declares the shape it expects, so the type is still
		// checked on the consuming side.
		render: async (_ctx, data) => ({
			component: App,
			props: data as RouteProps as unknown as Record<string, unknown>,
		}),
		renderOptions: async (ctx, data) => {
			const manifest = await manifestPromise;
			const props = data as RouteProps;
			const origin = resolveRequestOrigin(ctx.request.headers as HeaderBag);

			const assets = viteAssetsForEntry(manifest, CLIENT_ENTRY, { base: CLIENT_ASSET_BASE });
			const hydration = externalHydrationForEntry(manifest, CLIENT_ENTRY, props, {
				base: CLIENT_ASSET_BASE,
				dataUrl: hydrationDataUrlForRequest(ctx.request.path, ctx.request.query),
			});

			const head = headTagsForRoute(props, origin);

			return {
				status: statusForPage(props.page),
				csp: STRICT_CSP,
				headers: { 'content-security-policy': buildStrictCspHeader() },
				htmlAttrs: { lang: 'en' },
				head: { title: head.title },
				headTags: [...head.tags, ...assets.headTags],
				hydration,
			};
		},
	});
}

/**
 * External hydration endpoint.
 *
 * Strict CSP forbids inline `<script>`, so render data cannot travel in the
 * document. The client fetches it from here instead, same-origin. Registered as
 * a FaceTheory resource route so it participates in normal routing rather than
 * being intercepted ahead of the app.
 */
const hydrationResource = {
	route: HYDRATION_DATA_PATH,
	handle: async (ctx: { request: { query?: Query; headers?: HeaderBag } }) => {
		const params = new URLSearchParams();
		for (const key of Object.keys(ctx.request.query ?? {})) {
			for (const value of ctx.request.query?.[key] ?? []) params.append(key, value);
		}

		const path = stripBasePath(params.get('path') ?? '/');
		void queryFromSearchString(params.get('search') ?? '');
		const props = await createRouteProps(path, ctx.request.headers);

		return {
			status: 200,
			headers: {
				'cache-control': 'no-store',
				'content-security-policy': buildStrictCspHeader(),
				'content-type': 'application/json; charset=utf-8',
				'x-content-type-options': 'nosniff',
			},
			cookies: [],
			body: new TextEncoder().encode(`${JSON.stringify(props)}\n`),
			isBase64: false,
		};
	},
};

const app = createFaceApp({
	faces: ROUTE_PATTERNS.map(createFaceForRoute),
	resources: [hydrationResource as never],
});

/**
 * Strip lesser's `/l` base path before routing.
 *
 * lesser's SSR host forwards the full public path; the route table is written
 * app-relative so the same code runs unchanged under any base path lesser might
 * reserve in future.
 */
function normalizeEvent(event: LambdaUrlEvent): LambdaUrlEvent {
	const rawPath = stripBasePath(event.rawPath ?? event.requestContext?.http?.path ?? '/');

	return {
		...event,
		rawPath,
		requestContext: {
			...event.requestContext,
			http: { ...event.requestContext?.http, path: rawPath },
		},
	};
}

export async function handler(event: LambdaUrlEvent) {
	return handleLambdaUrlEvent(app, normalizeEvent(event));
}
