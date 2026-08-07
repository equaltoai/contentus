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
import { fetchAgent, fetchAgentRoster } from '$lib/agents/contract';
import { resolveAgentFilters } from '$lib/agents/filters';
import { mcpConnectOrigin } from '$lib/agents/mcp';
import { loadSourceStatus } from '$lib/cms/compose';
import { loadArticleBySlug, loadArticlesIndex, loadFilteredIndex } from '$lib/cms/loaders';
import { CLIENT_ASSET_BASE, HYDRATION_DATA_PATH } from '$lib/config/base-path';
import { fetchActor, fetchTimelinePage } from '$lib/timelines/transport';
import { isServerFetchable, tabFor } from '$lib/timelines/tabs';
import { subscriptionEndpoint } from '$lib/timelines/subscription';

import App from './App.svelte';
import { queryFromSearchString } from './query-parser';
import {
	ROUTE_PATTERNS,
	resolveAgentUsername,
	resolveComposeIntent,
	resolveConversationId,
	resolveDraftId,
	resolveMessageFolder,
	resolvePage,
	resolveProfileUsername,
	resolveReviewPanel,
	resolveSlug,
	resolveTimelineTab,
	statusForRoute,
	stripBasePath,
} from './routing';
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
async function createRouteProps(
	path: string,
	headers: HeaderBag | undefined,
	query?: Query
): Promise<RouteProps> {
	const page = resolvePage(path);
	const slug = resolveSlug(path);
	const endpoint = graphqlEndpointForOrigin(resolveRequestOrigin(headers));
	const ctx = { endpoint };

	const base: RouteProps = {
		page,
		slug,
		index: null,
		reader: null,
		compose: null,
		review: null,
		timelines: null,
		messages: null,
		agents: null,
		agentDetail: null,
		profile: null,
	};

	switch (page.key) {
		case 'articles-index':
			return { ...base, index: await loadArticlesIndex(ctx) };
		case 'series':
			return { ...base, index: await loadFilteredIndex(ctx, 'series', slug ?? '') };
		case 'category':
			return { ...base, index: await loadFilteredIndex(ctx, 'category', slug ?? '') };
		case 'article-reader':
			return { ...base, reader: await loadArticleBySlug(ctx, slug ?? '') };
		case 'compose': {
			// Anonymous, like every server pass: there is no token to attach. A
			// public reply target resolves here and appears in the first paint; a
			// followers-only or direct one comes back null and the client loads it
			// with the session token on mount. No token is ever attached here, so
			// a cached SSR document can never carry a status its reader could not
			// otherwise see.
			const intent = resolveComposeIntent(query);
			const source = intent.statusId ? await loadSourceStatus(intent.statusId, { endpoint }) : null;
			return { ...base, compose: { intent, source } };
		}
		case 'timelines': {
			// Instance and Federated are anonymous-safe reads of public content,
			// so the server fetches the first page and a cold deep link paints a
			// real timeline rather than a spinner. Home is neither — it needs a
			// token the server does not have, and these props are serialized
			// into the PUBLIC hydration endpoint below — so it is left for the
			// client, which is what a null page with a null failure means.
			const tab = tabFor(resolveTimelineTab(query));
			if (!isServerFetchable(tab)) {
				return { ...base, timelines: { tab: tab.id, page: null, failure: null, partial: false } };
			}

			// `partial` travels with the page. The transport keeps a half-failed
			// read's objects and marks it rather than reporting a false empty, and
			// that marker has to survive the props boundary or the server pass —
			// the only pass a no-script reader gets — paints a timeline that
			// asserts completeness lesser never claimed.
			const result = await fetchTimelinePage({ type: tab.type, endpoint });
			return {
				...base,
				timelines: {
					tab: tab.id,
					page: result.ok ? result.page : null,
					failure: result.ok ? null : result.failure,
					partial: result.ok && result.partial,
				},
			};
		}
		case 'messages':
		case 'message-thread':
			// THE ADDRESS TRAVELS, THE CORRESPONDENCE DOES NOT — the strictest
			// instance of the rule `/review` and `/review/drafts/{id}` already
			// follow. Every conversation operation needs a bearer token, the session
			// lives in `sessionStorage`, and these props are serialized VERBATIM
			// into the PUBLIC hydration endpoint further down this file. A
			// server-side `conversations` or `conversationMessages` fetch would put
			// one reader's private messages behind a URL anyone could request — the
			// worst version of the mistake, because unlike a draft there is no
			// version of a DM that was ever meant to be public.
			//
			// So the server ships the route, its folder, and the conversation id it
			// was asked for. The messages arrive once the client has read the
			// session.
			return {
				...base,
				messages: {
					folder: resolveMessageFolder(query),
					conversationId: resolveConversationId(path),
				},
			};
		case 'agents': {
			// Anonymous-safe, so the server paints a real roster. lesser resolves
			// the viewer optionally for `agents` and requires a caller only for the
			// `ownerUsername` argument, which this surface does not use — the
			// viewer's own agents are a client-only read on the same route.
			const filters = resolveAgentFilters(query);
			const result = await fetchAgentRoster(
				{ endpoint },
				{
					type: filters.type,
					query: filters.query,
					verified: filters.verified,
					after: filters.after,
				}
			);

			return {
				...base,
				agents: {
					page: result.ok ? result.page : null,
					failure: result.ok ? null : result.failure,
					filters,
				},
			};
		}
		case 'agent-detail': {
			// Anonymous, like the roster. `mcpAccess` is not among the fields lesser
			// redacts for non-owners, so the whole published MCP contract —
			// endpoint, protected-resource URL, scopes, guidance — lands in the
			// server's paint and a reader with no script still gets every address.
			// The live probes against those addresses are the client's; they are
			// requests to a sibling origin and would report the SSR host's
			// reachability rather than the reader's.
			const username = resolveAgentUsername(path);
			const result = await fetchAgent({ endpoint }, username ?? '');

			return {
				...base,
				agentDetail: {
					username,
					agent: result.ok ? result.agent : null,
					failure: result.ok ? null : result.failure,
				},
			};
		}
		case 'profile': {
			// Both halves are anonymous-safe, so the profile renders completely
			// on the server. The actor is resolved first because its `id` is
			// what the ACTOR timeline is keyed on — lesser takes `actorId`, not
			// a username — so a profile that does not resolve has no timeline to
			// ask for either, and says so once instead of twice.
			const handle = resolveProfileUsername(path);
			if (!handle)
				return {
					...base,
					profile: {
						handle: null,
						actor: null,
						page: null,
						failure: 'not-found',
						pagePartial: false,
						actorPartial: false,
					},
				};

			const actorResult = await fetchActor(handle, { endpoint });
			if (!actorResult.ok) {
				return {
					...base,
					profile: {
						handle,
						actor: null,
						page: null,
						failure: actorResult.failure,
						pagePartial: false,
						actorPartial: false,
					},
				};
			}

			const timeline = await fetchTimelinePage({
				type: 'ACTOR',
				actorId: actorResult.actor.id,
				endpoint,
			});

			// Both markers travel, and separately. The card and the posts are two
			// reads that fail independently: an actor that half-resolved is shown
			// with a field missing from the header, which is not the same event as
			// a post whose boost could not be read.
			return {
				...base,
				profile: {
					handle,
					actor: actorResult.actor,
					page: timeline.ok ? timeline.page : null,
					failure: timeline.ok ? null : timeline.failure,
					pagePartial: timeline.ok && timeline.partial,
					actorPartial: actorResult.partial,
				},
			};
		}
		case 'review-workspace':
			// The ADDRESS travels, the DRAFT does not. Same rule as the queue
			// below, one step sharper: `draftPreview` renders an unpublished
			// body, and these props are serialized verbatim into the PUBLIC
			// hydration endpoint further down this file. A server-side preview
			// fetch would put that body behind a URL anyone could request.
			return {
				...base,
				review: { draftId: resolveDraftId(path), panel: resolveReviewPanel(query) },
			};
		default:
			// auth-callback, not-found, and the review queue render without server
			// data. The first needs sessionStorage and the second has nothing to
			// fetch; the review queue is the load-bearing one, and its emptiness
			// here is deliberate. Every review operation needs a bearer token,
			// and these props are serialized verbatim into the PUBLIC hydration
			// endpoint below — so a server-side queue fetch would put one
			// reviewer's unpublished drafts behind a URL anyone could request.
			// The server ships the route and its signed-out chrome; the client
			// loads the queue once it has read the session.
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
 * The canonical link href: lesser's absolute Article identity, emitted only
 * when it is same-origin with the edge-verified request origin.
 *
 * FaceTheory 4.0.6 derives a per-request `allowedOrigin` and validates every
 * head `<link href>` against it under strict CSP (`dist/app.js`
 * `allowedOriginForRequest` → `renderFaceHead`). Before that, an absolute href
 * threw even for the page's own origin — the workaround below emitted the
 * RELATIVE form. The framework now forwards the origin, so the link carries
 * the absolute identity it should have carried all along. `normalizeEvent`
 * translates the trusted `x-lesser-forwarded-*` pair into the headers
 * FaceTheory reads, so the origin it validates against is the edge-verified
 * one and never a viewer-supplied `x-forwarded-host`.
 *
 * The guard stays: a genuinely cross-origin canonical (a syndicated
 * `article.canonicalUrl`) can never pass the same-origin check, and emitting
 * it would throw the route to a 500, so it gets no link tag at all — `og:url`
 * still carries the absolute identity, since meta content is not subject to
 * this check.
 */
function canonicalLinkHref(canonical: string | null, origin: string | null): string | null {
	if (!canonical || !origin) return null;
	try {
		if (new URL(canonical).origin !== new URL(origin).origin) return null;
	} catch {
		return null;
	}
	return canonical;
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
	} else if (origin) {
		// Shared links render a card only when og:image is present, and most
		// articles carry none. The brand card stands in — absolute, because a
		// relative og:image resolves against nothing a crawler can rely on, and
		// meta content is not subject to the strict-CSP same-origin check that
		// governs <link href>. No origin means no claim about where the card
		// lives, so none is made.
		tags.push({
			type: 'meta',
			attrs: { property: 'og:image', content: `${origin}${CLIENT_ASSET_BASE}brand/og-card.png` },
		});
	}

	return { title, tags };
}

/**
 * The strict-CSP options for a route.
 *
 * FaceTheory's canonical policy is `connect-src 'self'`, which is right for
 * every surface contentus had before face 4: the GraphQL endpoint, the media
 * uploads and the hydration document are all same-origin. lesser's GraphQL
 * SUBSCRIPTIONS are not — they are served from `wss://ws.<domain>`, a sibling
 * host of the one serving this page — so without an addition here the browser
 * blocks the socket before it opens and realtime silently never works.
 *
 * The addition is as narrow as the policy allows and stays strict in every
 * other respect. It is ONE origin, DERIVED from the request that was actually
 * served rather than configured, added ONLY on the routes that open a socket,
 * and it never touches `script-src` or `style-src`: no `unsafe-inline`, no
 * `unsafe-eval`, no third-party origin. When the origin cannot be resolved the
 * policy is left exactly as it was — a page that cannot name its own instance
 * gets no widening at all.
 *
 * `/profiles/{username}` deliberately does NOT get it: ACTOR timelines have no
 * subscription (lesser's `timelineUpdates` takes a type and a listId, not an
 * actor), so that route opens no socket and has no reason to permit one.
 *
 * The two messaging routes DO get it, for the same reason `/timelines` does:
 * `subscription conversationUpdates` is served from the same `wss://ws.<domain>`
 * sibling host, and both the list and the thread open one — an incoming message
 * has to reach the list a reader is looking at as well as the thread they have
 * open (product design §5).
 */
const SOCKET_ROUTES: ReadonlySet<string> = new Set(['timelines', 'messages', 'message-thread']);

/**
 * `/agents/{username}` gets the same treatment for the same reason, one
 * milestone later and from a better source.
 *
 * The MCP detail panel probes two discovery documents in the browser, and lesser
 * canonicalises MCP onto `api.<domain>` (`canonicalMCPResourceBaseURL`) — a
 * sibling of the host serving this page — so without an addition here the
 * browser blocks both probes before they leave.
 *
 * The addition is narrower than the socket one in the way that matters: the
 * origin is not derived from the request at all, it is the ORIGIN OF THE URL
 * LESSER JUST RETURNED for this agent. If lesser published no MCP endpoint,
 * there is nothing to probe and nothing is added. Still exactly one origin,
 * still only on the route that connects, and still never touching `script-src`
 * or `style-src`: no `unsafe-inline`, no `unsafe-eval`, no third-party origin.
 */
function cspOptionsForRoute(props: RouteProps, origin: string | null) {
	if (props.page.key === 'agent-detail') {
		const mcpOrigin = mcpConnectOrigin(props.agentDetail?.agent?.mcpAccess);
		return mcpOrigin ? { directives: { 'connect-src': [mcpOrigin] } } : {};
	}

	if (!SOCKET_ROUTES.has(props.page.key)) return {};

	const endpoint = subscriptionEndpoint(origin);
	return endpoint ? { directives: { 'connect-src': [endpoint] } } : {};
}

/**
 * Response headers for a rendered route.
 *
 * WHY AN AUTH-REQUIRED ROUTE STILL ANSWERS 200, stated here because it looks
 * wrong and the reasoning is load-bearing.
 *
 * `/review`, `/review/drafts/{id}`, and `/compose` require an authenticated
 * caller, and an anonymous request to one of them gets HTTP 200 with a sign-in
 * shell. The correct-looking answer — 401, or a redirect to sign-in — is not
 * available at this boundary, and not because the framework lacks a hook:
 * `renderOptions` returns both `status` and `headers`, so contentus could send
 * either. It is that THE SERVER CANNOT TELL WHO IS ASKING. lesser's auth
 * contract is Authorization Code + PKCE with the token in `sessionStorage`
 * (never a cookie — `$lib/auth/session`), so no credential is presented on the
 * document request at all. A blanket 401 would be returned to the authenticated
 * reviewer as readily as to the anonymous visitor, and lesser performs no SPA
 * fallback under `/l/*`, so every cold deep link a signed-in reviewer follows
 * would answer "unauthorized" for a page they are authorized to use. That
 * trades one false signal for a worse one.
 *
 * What IS true of this response is that it delivered the sign-in shell, which
 * is a 200, and that it carries no protected data — `tests/ssr-review.test.mjs`
 * asserts the anonymous document contains no draft and that the server makes no
 * authenticated fetch. The drafts themselves live behind authenticated GraphQL,
 * which answers 401 correctly.
 *
 * WHAT THIS FIXES ANYWAY. The residual risk in a 200 is that a shared cache or
 * a crawler treats the protected surface as ordinary public content, so these
 * two headers close that half at the boundary that does control it: `no-store`
 * keeps the shell out of every cache, and `noindex, nofollow` keeps it out of
 * indexes. Neither is available to lesser to set on contentus's behalf — the
 * origin owns its headers on `/l` routes.
 *
 * The remaining half — that anonymous access to a protected route reads as
 * success to monitoring — is a genuine limitation of a client whose credential
 * is invisible to its own server. Routed rather than left silent; see
 * `docs/consumption/auth-boundary.md`.
 */
function headersForRoute(props: RouteProps, origin: string | null): Record<string, string> {
	const headers: Record<string, string> = {
		'content-security-policy': buildStrictCspHeader(cspOptionsForRoute(props, origin)),
	};

	if (props.page.requiresAuth) {
		headers['cache-control'] = 'no-store';
		headers['x-robots-tag'] = 'noindex, nofollow';
	}

	return headers;
}

function createFaceForRoute(route: string) {
	return createSvelteFace({
		route,
		mode: 'ssr',
		load: async (ctx) =>
			createRouteProps(ctx.request.path, ctx.request.headers as HeaderBag, ctx.request.query),
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
				status: statusForRoute(props),
				csp: STRICT_CSP,
				headers: headersForRoute(props, origin),
				// `data-theme="dark"` cannot be set here: FaceTheory v4.0.6's
				// adapter pipeline (assembleFaceRenderResult) does not forward
				// htmlAttrs from renderOptions, so these attributes would never
				// reach the document. The theme and the gray-ramp palette
				// preset ride the shell root in AppShell.svelte instead; the
				// vendored dark rules only need an ancestor, not <html>.
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
 *
 * IT CARRIES THE SAME HEADERS AS THE DOCUMENT IT HYDRATES, and that was a gap:
 * `/messages` and `/messages/{id}` are served `no-store` AND
 * `noindex, nofollow`, but their hydration payload — the same props, at a URL
 * anybody can request — carried only the first. The props are deliberately
 * data-free (`tests/ssr-messages.test.mjs` drives both response kinds, with and
 * without an inbound credential, and asserts the server makes no fetch and
 * carries no conversation), so this closes a header gap rather than a leak.
 *
 * Applied unconditionally rather than only for `requiresAuth` routes, because
 * the reasoning does not depend on the route: a JSON hydration payload is never
 * the indexable representation of anything. The document is.
 */
const hydrationResource = {
	route: HYDRATION_DATA_PATH,
	handle: async (ctx: { request: { query?: Query; headers?: HeaderBag } }) => {
		const params = new URLSearchParams();
		for (const key of Object.keys(ctx.request.query ?? {})) {
			for (const value of ctx.request.query?.[key] ?? []) params.append(key, value);
		}

		const path = stripBasePath(params.get('path') ?? '/');
		// The document's own query string travels in `search`, so hydration
		// resolves the SAME intent the server rendered. Without it, a deep-linked
		// reply would hydrate into a blank new post.
		const search = queryFromSearchString(params.get('search') ?? '');
		const props = await createRouteProps(path, ctx.request.headers, search);

		return {
			status: 200,
			headers: {
				'cache-control': 'no-store',
				'content-security-policy': buildStrictCspHeader(),
				'content-type': 'application/json; charset=utf-8',
				'x-content-type-options': 'nosniff',
				'x-robots-tag': 'noindex, nofollow',
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
	// FaceTheory swallows render errors into its safe 500 document and reports
	// them ONLY through these hooks — with no hook, a route that throws is a
	// silent 500 in CloudWatch, which is exactly how the double-instantiation
	// fault (see vite.config.ts `codeSplitting`) ran undetected. Logging here
	// changes nothing about the response; it makes the next failure diagnosable
	// from the SSR host's logs alone.
	observability: {
		log: (event: { level: string; event: string; path?: string; routePattern?: string }) => {
			if (event.level === 'error') console.error('[facetheory]', JSON.stringify(event));
		},
		onError: (
			error: unknown,
			ctx: { path?: string; routePattern?: string; phase?: string; errorClass?: string }
		) => {
			console.error(
				'[facetheory] render error',
				JSON.stringify({
					path: ctx.path,
					routePattern: ctx.routePattern,
					phase: ctx.phase,
					errorClass: ctx.errorClass,
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				})
			);
		},
	},
});

/**
 * Strip lesser's `/l` base path before routing.
 *
 * lesser's SSR host forwards the full public path; the route table is written
 * app-relative so the same code runs unchanged under any base path lesser might
 * reserve in future.
 *
 * Also translate the TRUSTED origin into the headers FaceTheory 4.0.6 reads.
 * FaceTheory derives its strict-CSP `allowedOrigin` from `x-forwarded-host` /
 * `x-forwarded-proto` (or falls back to `host`), and those are viewer-settable
 * on `/l/*`: CloudFront forwards viewer headers verbatim, and only the
 * `x-lesser-forwarded-*` pair is overwritten at the edge. So the trusted pair
 * is resolved here, any viewer-supplied `x-forwarded-*` is REPLACED by the
 * edge-verified values, and when no trusted origin exists both are deleted —
 * FaceTheory then cannot derive an origin at all, which is the fail-closed
 * answer (no absolute canonical is emitted in that case either).
 */
function normalizeEvent(event: LambdaUrlEvent): LambdaUrlEvent {
	const rawPath = stripBasePath(event.rawPath ?? event.requestContext?.http?.path ?? '/');

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(event.headers ?? {})) {
		const lower = name.toLowerCase();
		if (lower === 'x-forwarded-host' || lower === 'x-forwarded-proto') continue;
		if (typeof value === 'string') headers[lower] = value;
	}

	const origin = resolveRequestOrigin(headers);
	if (origin) {
		const url = new URL(origin);
		headers['x-forwarded-host'] = url.host;
		headers['x-forwarded-proto'] = url.protocol.replace(':', '');
	}

	return {
		...event,
		headers,
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
