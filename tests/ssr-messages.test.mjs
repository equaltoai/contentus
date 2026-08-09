/**
 * Face 5's SSR probes.
 *
 * These drive the BUILT handler (`build/server/handler.mjs`) exactly as
 * lesser's SSR host does, so what is asserted is what ships — including
 * whatever the vendored components emit. Source inspection would be weaker
 * evidence.
 *
 * THE CENTRAL CLAIM, and it is stricter here than on any earlier face: the
 * server renders `/messages` and `/messages/{id}` WITHOUT READING ANY PART OF
 * THE DM SURFACE. These props are serialized verbatim into contentus's PUBLIC
 * hydration endpoint, and a direct message is the one kind of content on this
 * instance that was never meant to be public in any form. So the probes below
 * assert both halves — no conversation, participant or message in the document,
 * and no request that names one while producing it.
 *
 * WHAT CHANGED AT lesser v1.6.4. The old pin was "no outbound request at all",
 * and it was true because the socket host was DERIVED from the request origin —
 * there was nothing to ask. v1.6.4 serves `InstanceInfo.subscriptionUrl`, and
 * these routes' CSP `connect-src` is now the origin of that SERVED value, so
 * the server pass may issue EXACTLY ONE request: the anonymous instance query,
 * carrying no credential and no variable naming a conversation, a participant
 * or a message. The pin below says exactly that, and the rest of the old claim
 * is unchanged.
 *
 * The stub records the `authorization` header it actually saw (the N1 fix from
 * M4). That is what makes "the server made no authenticated fetch" an assertion
 * about an observation rather than a comparison of two absences.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	AUDIT_HEADERS,
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

/**
 * The same request, carrying a credential.
 *
 * WHY IT MATTERS THAT THIS EXISTS. Every probe below used the default header
 * bag, which has no `Authorization` — so the whole file was evidence about the
 * ANONYMOUS request only. A future "fetch only when the caller is
 * authenticated" path would have walked straight past it, and the claim these
 * tests make ("the server reads only the public instance info on this surface")
 * would have quietly become "...when nobody is signed in". lesser's edge does
 * forward request headers, so an authenticated reader's own document request can
 * carry one.
 *
 * The token is a marker as well as a credential: nothing in any response may
 * contain it, which also catches an echo into the hydration payload.
 */
const INBOUND_CREDENTIAL = 'Bearer probe-token-never-to-be-forwarded';
const AUTHENTICATED_HEADERS = {
	...AUDIT_HEADERS,
	authorization: INBOUND_CREDENTIAL,
	cookie: 'contentus_probe=should-not-be-read',
};

/** The hydration URL a rendered document actually tells the browser to fetch. */
function hydrationUrl(html) {
	const found = html.match(/\/l\/_facetheory\/hydration\?[^"']+/);
	assert.ok(found, 'the document advertises no hydration URL');
	return found[0];
}

/**
 * Every messaging route, so a route added to the audit table without a probe
 * fails here rather than being silently uncovered.
 */
const MESSAGING_ROUTES = [
	'messages-inbox',
	'messages-requests',
	'message-thread',
	'messages-no-id',
];

test('every messaging route in the audit table is probed here', () => {
	const inTable = AUDIT_ROUTES.filter((entry) => entry.path.includes('/messages')).map(
		(entry) => entry.name
	);
	assert.deepEqual(
		inTable.slice().sort(),
		MESSAGING_ROUTES.slice().sort(),
		'a /messages route exists in AUDIT_ROUTES that this file does not cover'
	);
});

/**
 * The instance-info payload every stubbed render in this file serves. The
 * subscription URL lives on a DELIBERATELY DIFFERENT host from the page host,
 * so any code path that still derives the socket origin from the request host
 * would fail the CSP assertion below.
 */
const instanceInfoPayload = () => ({
	subscriptionUrl: 'wss://realtime.served-lesser.invalid/graphql',
	maxUploadSizeBytes: 10_485_760,
	maxStatusCharacters: 5_000,
	cmsFeatures: {
		longForm: true,
		drafts: true,
		revisions: true,
		scheduling: false,
		series: true,
		categories: true
	}
});

/**
 * A fresh, unique host per test. The built handler's server-side instance cache
 * is module-level with a 60-second TTL keyed by endpoint, so two stubbed renders
 * through the same host in one process would share the first render's (possibly
 * failed or differently-fixtured) entry. Unique hosts give each test a cold
 * cache — the same trick the request-forwarding probes use to pin `endpoint`,
 * at the cache-key layer.
 */
const freshHostHeaders = (marker) => {
	const host = `contentus-audit-${marker}.invalid`;
	return {
		host,
		'x-lesser-forwarded-host': host,
		'x-lesser-forwarded-proto': 'https'
	};
};

test('the server issues EXACTLY ONE request on a messaging route — the anonymous instance query', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const { requests } = await withStubbedGraphql(
			() => ({ data: { instance: instanceInfoPayload() } }),
			() =>
				renderRoute(handler, {
					...route(name),
					headers: freshHostHeaders(`one-read-${name}`)
				})
		);

		// Asserted on the RECORDED requests, not inside the stub: an assertion
		// thrown in `respond` would be swallowed by `fetchInstanceInfo`'s
		// never-throws contract and surface as a spurious pass.
		assert.equal(
			requests.length,
			1,
			`${name} must make exactly one outbound request on the server pass; saw ${requests.length}`
		);
		assert.equal(
			requests[0].operation,
			'ContentusInstanceInfo',
			`${name}'s one request must be the instance query; saw ${requests[0].operation}`
		);
		assert.deepEqual(
			requests[0].variables ?? {},
			{},
			`${name}'s instance query must carry no variable — nothing names a conversation, participant or message`
		);
		assert.equal(
			requests[0].authorization ?? null,
			null,
			`${name}'s instance query carried an Authorization header`
		);
	}
});

test('no messaging route sends an Authorization header from the server', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const { requests } = await withStubbedGraphql(
			() => ({ data: { instance: instanceInfoPayload() } }),
			() =>
				renderRoute(handler, {
					...route(name),
					headers: freshHostHeaders(`anon-${name}`)
				})
		);

		// Belt and braces against the previous test: the one request now allowed
		// here is the instance query, and it still must not carry a credential.
		// The stub RECORDS the header it saw, so this compares an observation
		// with null rather than two absences — the vacuous-probe defect codex
		// found in M4.
		for (const request of requests) {
			assert.equal(
				request.operation,
				'ContentusInstanceInfo',
				`${name} made an unexpected request: ${request.operation}`
			);
			assert.equal(
				request.authorization ?? null,
				null,
				`${name} sent an Authorization header to ${request.url}`
			);
		}
	}
});

/**
 * Values that could only appear if the server had read the DM surface. If any of
 * these reaches the document, it reaches the public hydration endpoint too.
 */
const SECRETS = [
	'conversation-123',
	'lastStatus',
	'viewerMetadata',
	'requestState',
	'conversationMessages',
];

test('a request carrying a credential still makes the server read only the public instance info', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const { value, requests } = await withStubbedGraphql(
			() => ({ data: { instance: instanceInfoPayload() } }),
			() =>
				renderRoute(handler, {
					...route(name),
					headers: {
						...freshHostHeaders(`cred-${name}`),
						authorization: INBOUND_CREDENTIAL,
						cookie: 'contentus_probe=should-not-be-read'
					}
				})
		);

		// The authenticated-callers-only read this probe exists to catch would be
		// a SECOND request, or an instance query that grew a credential. Neither
		// is permitted: the instance query is anonymous BY CONSTRUCTION — the
		// fetch helper takes no token parameter, so a forwarded credential here
		// means the boundary itself broke, not that a caller misused it.
		assert.equal(
			requests.length,
			1,
			`${name} fetched on behalf of an authenticated caller; saw ${requests.length} requests`
		);
		assert.equal(
			requests[0].operation,
			'ContentusInstanceInfo',
			`${name}'s authenticated render made an unexpected request: ${requests[0].operation}`
		);
		assert.equal(
			requests[0].authorization ?? null,
			null,
			`${name} forwarded the inbound credential to lesser`
		);
		assert.equal(value.status, 200);
		assert.ok(
			!value.html.includes('probe-token-never-to-be-forwarded'),
			`${name} echoed the inbound credential into the document`
		);
		for (const secret of SECRETS) {
			if (name === 'message-thread' && secret === 'conversation-123') continue;
			assert.ok(
				!value.html.includes(secret),
				`${name} document contains "${secret}" for an authenticated caller`
			);
		}
	}
});

test('the hydration payload reads nothing either, credential or not', async () => {
	const handler = await loadHandler();

	// THE RESOURCE, NOT ONLY THE DOCUMENT. These props are the same object the
	// document was rendered from, served at a URL anybody can request — so a
	// server-side read added here would put private correspondence behind a plain
	// GET. Probed at the URL the document itself advertises rather than one this
	// test composed, so it is the request the browser actually makes.
	for (const name of MESSAGING_ROUTES) {
		const document = await renderRoute(handler, route(name));
		const path = hydrationUrl(document.html);

		for (const headers of [AUDIT_HEADERS, AUTHENTICATED_HEADERS]) {
			const { value, requests } = await withStubbedGraphql(
				() => {
					assert.fail(`the hydration payload for ${name} made a GraphQL request`);
				},
				() => renderRoute(handler, { name: `${name}-hydration`, path, headers })
			);

			assert.equal(requests.length, 0, `${name} hydration fetched something`);
			assert.equal(value.status, 200, `${name} hydration should answer 200`);
			assert.ok(
				!value.html.includes('probe-token-never-to-be-forwarded'),
				`${name} hydration echoed the inbound credential`
			);
			assert.ok(
				!value.html.includes('should-not-be-read'),
				`${name} hydration echoed an inbound cookie`
			);

			for (const secret of SECRETS) {
				// The thread's own address is the one value it legitimately carries:
				// the id came from the caller's URL and is echoed back as the route it
				// asked to hydrate.
				if (name === 'message-thread' && secret === 'conversation-123') continue;
				assert.ok(!value.html.includes(secret), `${name} hydration payload contains "${secret}"`);
			}
		}
	}
});

test('the hydration payload is uncacheable and unindexed, like the document it hydrates', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const document = await renderRoute(handler, route(name));
		const hydration = await renderRoute(handler, {
			name: `${name}-hydration`,
			path: hydrationUrl(document.html),
		});

		// The document carries both headers; the payload carried only the first.
		// A protected surface whose JSON twin was indexable is a header gap
		// whether or not today's payload is empty — and "today's payload is
		// empty" is exactly the kind of fact that changes.
		assert.equal(hydration.headers['cache-control'], 'no-store', `${name} hydration is cacheable`);
		assert.equal(
			hydration.headers['x-robots-tag'],
			'noindex, nofollow',
			`${name} hydration is indexable`
		);
		assert.equal(hydration.headers['x-content-type-options'], 'nosniff');
		assert.match(hydration.headers['content-type'] ?? '', /application\/json/);
	}
});

test('the anonymous document carries no conversation, participant or message', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const rendered = await renderRoute(handler, route(name));

		assert.equal(rendered.status, 200, `${name} should render 200`);

		for (const secret of SECRETS) {
			// The thread route legitimately carries its own path, so the id is
			// permitted in a link href but nowhere else. Asserting on the whole
			// document would fail on the address the route IS.
			if (name === 'message-thread' && secret === 'conversation-123') continue;
			assert.ok(
				!rendered.html.includes(secret),
				`${name} document contains "${secret}" — the server read the DM surface`
			);
		}
	}
});

test('an auth-gated messaging route is uncacheable and unindexed', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const rendered = await renderRoute(handler, route(name));

		// The 200 is the designed answer — the server cannot identify the caller,
		// so it ships the sign-in shell. These two headers are what stop that shell
		// being cached or indexed as ordinary public content. See `headersForRoute`.
		assert.equal(rendered.headers['cache-control'], 'no-store', `${name} must not be cacheable`);
		assert.equal(
			rendered.headers['x-robots-tag'],
			'noindex, nofollow',
			`${name} must not be indexable`
		);
	}
});

test('the anonymous render explains the sign-in rather than showing an empty inbox', async () => {
	const handler = await loadHandler();
	const rendered = await renderRoute(handler, route('messages-inbox'));

	// The false-empty rule, at the SSR boundary. A server render that said "No
	// conversations yet" would be telling a signed-in reader they have no
	// messages, because the server cannot see their session.
	assert.ok(
		!/no conversations yet/i.test(rendered.html),
		'the anonymous document claims an empty inbox'
	);
	assert.ok(
		!/no message requests/i.test(rendered.html),
		'the anonymous document claims there are no requests'
	);
	assert.ok(
		/sign in/i.test(rendered.html),
		'the anonymous document should explain that messages need a sign-in'
	);
});

test('the messaging routes permit the SERVED subscription origin and nothing wider', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const { value } = await withStubbedGraphql(
			() => ({ data: { instance: instanceInfoPayload() } }),
			() =>
				renderRoute(handler, {
					...route(name),
					headers: freshHostHeaders(`csp-${name}`)
				})
		);
		const csp = value.headers['content-security-policy'] ?? '';

		// The fixture's subscription host is NOT a sibling of the page host — it
		// shares no domain with `contentus-audit-csp-*.invalid` at all — so this
		// passing is proof the origin came from lesser v1.6.4's served
		// `InstanceInfo.subscriptionUrl`. The old derivation
		// (`wss://ws.<page-host>`) would put a different origin here and fail.
		assert.match(
			csp,
			/connect-src[^;]*wss:\/\/realtime\.served-lesser\.invalid/,
			`${name} must permit the served subscription origin`
		);
		// CSP source expressions are origins: the `/graphql` path of the served
		// URL must NOT leak into the directive.
		assert.ok(
			!/connect-src[^;]*\/graphql/.test(csp),
			`${name} CSP leaked the subscription URL's path into connect-src`
		);

		// And it stays strict everywhere else. These are the directives a widening
		// mistake would show up in first.
		assert.ok(!/unsafe-inline/.test(csp), `${name} CSP contains unsafe-inline`);
		assert.ok(!/unsafe-eval/.test(csp), `${name} CSP contains unsafe-eval`);
		assert.match(csp, /script-src[^;]*'self'/, `${name} script-src should be self`);
	}
});

test('a messaging route whose instance query fails widens NOTHING', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		// `data: null` fails the instance-info shape check closed, exactly as a
		// transport error, a 500, or a pre-v1.6.4 lesser would.
		const { value } = await withStubbedGraphql(
			() => ({ data: null }),
			() =>
				renderRoute(handler, {
					...route(name),
					headers: freshHostHeaders(`csp-fail-${name}`)
				})
		);
		const csp = value.headers['content-security-policy'] ?? '';

		// Fail-closed at the CSP layer: no served subscriptionUrl, no addition.
		// The page still renders — the client reports realtime unavailable — but
		// the document never grows a connect-src lesser did not vouch for.
		const connectSrc = csp.match(/connect-src[^;]*/)?.[0] ?? '';
		assert.equal(
			connectSrc.trim(),
			"connect-src 'self'",
			`${name} widened connect-src despite a failed instance query: "${connectSrc.trim()}"`
		);
	}
});

test('a folder in the URL is what the server renders, not a default', async () => {
	const handler = await loadHandler();

	const inbox = await renderRoute(handler, route('messages-inbox'));
	const requests = await renderRoute(handler, route('messages-requests'));

	// The two documents must differ: `?folder=requests` travels through
	// `createRouteProps` into the hydration payload, so a Requests link opens on
	// Requests rather than opening on Inbox and switching a beat later. Equal
	// documents would mean the folder never left the query string.
	assert.notEqual(
		inbox.html,
		requests.html,
		'?folder=requests renders identically to the inbox — the folder is not reaching the props'
	);
	assert.ok(
		requests.html.includes('requests'),
		'the requests document should carry the addressed folder'
	);
});

test('`/messages/` with no id renders the list, not an empty thread', async () => {
	const handler = await loadHandler();

	const noId = await renderRoute(handler, route('messages-no-id'));

	// The trailing slash normalizes away, so this resolves to the LIST page.
	// What it must never be is the thread surface rendering a conversation
	// nobody named — the rule `/review/drafts` and `/profiles` follow.
	//
	// Asserted on the resolved PAGE rather than on document equality with
	// `/l/messages`: the two documents legitimately differ in their CSP nonce
	// and in the hydration URL, which echoes the requested path. A byte
	// comparison would fail on both and prove nothing about routing.
	assert.equal(noId.status, 200);
	assert.match(noId.html, /data-page="messages"/, '`/messages/` should resolve to the list page');
	assert.ok(
		!noId.html.includes('data-page="message-thread"'),
		'`/messages/` must not resolve to the thread surface with no conversation'
	);
	// And it is the messages surface at all, rather than having fallen through
	// to not-found, which would also lack the thread marker.
	assert.ok(!noId.html.includes('data-page="not-found"'), '`/messages/` should not 404');
});

test('the renderer-authority disclosure is in the server document', async () => {
	const handler = await loadHandler();
	const rendered = await renderRoute(handler, route('messages-inbox'));

	// The disclosure is deliberately NOT gated on having messages: a reader with
	// an empty inbox who later receives one would otherwise meet the escaped
	// bodies with no explanation. It is not in the anonymous document, though —
	// the surface only mounts for a signed-in reader — so what is asserted here
	// is that the anonymous shell renders without it rather than that it is
	// present. The presence claim is `tests/vendored-messaging-render.test.mjs`,
	// which drives the component itself.
	assert.ok(
		!rendered.html.includes('Message bodies are shown as plain text'),
		'the disclosure should not appear in the anonymous shell, which renders no messages'
	);
});
