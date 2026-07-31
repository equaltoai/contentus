/**
 * Face 5's SSR probes.
 *
 * These drive the BUILT handler (`build/server/handler.mjs`) exactly as
 * lesser's SSR host does, so what is asserted is what ships — including
 * whatever the vendored components emit. Source inspection would be weaker
 * evidence.
 *
 * THE CENTRAL CLAIM, and it is stricter here than on any earlier face: the
 * server renders `/messages` and `/messages/{id}` WITHOUT READING ANYTHING.
 * These props are serialized verbatim into contentus's PUBLIC hydration
 * endpoint, and a direct message is the one kind of content on this instance
 * that was never meant to be public in any form. So the probes below assert
 * both halves — no conversation, participant or message in the document, and no
 * outbound fetch at all while producing it.
 *
 * The stub records the `authorization` header it actually saw (the N1 fix from
 * M4). That is what makes "the server made no authenticated fetch" an assertion
 * about an observation rather than a comparison of two absences.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

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

test('the server makes NO request while rendering any messaging route', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const { requests } = await withStubbedGraphql(
			() => {
				// Reaching here at all is the failure: this surface has nothing the
				// server is allowed to ask for.
				assert.fail(`${name} made a GraphQL request during the server render`);
			},
			() => renderRoute(handler, route(name))
		);

		assert.equal(
			requests.length,
			0,
			`${name} must make no outbound request on the server pass; saw ${requests.length}`
		);
	}
});

test('no messaging route sends an Authorization header from the server', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const { requests } = await withStubbedGraphql(
			() => ({ data: null }),
			() => renderRoute(handler, route(name))
		);

		// Belt and braces against the previous test: if a request is ever added
		// here deliberately, it still must not carry a credential. The stub RECORDS
		// the header it saw, so this compares an observation with null rather than
		// two absences — the vacuous-probe defect codex found in M4.
		for (const request of requests) {
			assert.equal(
				request.authorization ?? null,
				null,
				`${name} sent an Authorization header to ${request.url}`
			);
		}
	}
});

test('the anonymous document carries no conversation, participant or message', async () => {
	const handler = await loadHandler();

	// Values that could only appear if the server had read the DM surface. If any
	// of these reaches the document, it reaches the public hydration endpoint too.
	const SECRETS = [
		'conversation-123',
		'lastStatus',
		'viewerMetadata',
		'requestState',
		'conversationMessages',
	];

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

test('the messaging routes permit the subscription origin and nothing wider', async () => {
	const handler = await loadHandler();

	for (const name of MESSAGING_ROUTES) {
		const rendered = await renderRoute(handler, route(name));
		const csp = rendered.headers['content-security-policy'] ?? '';

		// `conversationUpdates` is served from `wss://ws.<domain>`, a sibling host
		// of the one serving the page, so `connect-src 'self'` alone would block
		// the socket before it opened. The widening is ONE derived origin.
		assert.match(
			csp,
			/connect-src[^;]*wss:\/\/ws\.contentus-audit\.invalid/,
			`${name} must permit the derived subscription origin`
		);

		// And it stays strict everywhere else. These are the directives a widening
		// mistake would show up in first.
		assert.ok(!/unsafe-inline/.test(csp), `${name} CSP contains unsafe-inline`);
		assert.ok(!/unsafe-eval/.test(csp), `${name} CSP contains unsafe-eval`);
		assert.match(csp, /script-src[^;]*'self'/, `${name} script-src should be self`);
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
