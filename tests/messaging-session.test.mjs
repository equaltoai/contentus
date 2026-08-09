/**
 * Sign-out, and what it has to take with it.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `clearSession()` emptied `sessionStorage` and
 * nothing else. The messages face read the session ONCE, in `onMount`, so
 * signing out left `Messages.Root` mounted with the conversations, the
 * participants and the bodies on screen — and left the AUTHORIZED SOCKET open,
 * still delivering. On a shared device the next person met the last one's inbox.
 *
 * AND THE SOCKET IS NOT THE WHOLE OF IT. Closing the stream is synchronous;
 * every HTTP read already dispatched — the folder, the open thread, the badge's
 * own count — resolves whenever it resolves, under whichever session is there
 * when it lands. The badge is the sharpest case: its store outlives every
 * binding it creates, so no teardown stands between one account's in-flight
 * count and the next account's nav. Those completions are stamped at dispatch
 * and dropped when the stamp names a dead session (`$lib/auth/session-scope`,
 * `$lib/auth/session-events`).
 *
 * WHAT IS EVIDENCE HERE AND WHAT IS WIRING. The first two groups drive REAL
 * shipped modules: `$lib/auth/session-events` directly, and the REAL binding
 * with a fake socket and a stubbed `fetch`, so "the socket closed" and "no
 * further event was delivered" are observations of shipped behaviour. The last
 * group parses the two components with the REAL Svelte compiler and asserts the
 * wiring between them exists — that `MessagesPage` subscribes to the session and
 * tears the binding down, that `AppShell` announces the sign-out. That is a
 * structural claim about the component, not a behavioural one; it is labelled as
 * such rather than dressed up as a render.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'svelte/compiler';

import {
	notifySessionChange,
	onSessionChange,
	sessionChangeListenerCount,
	sessionGeneration,
} from '../src/lib/auth/session-events.ts';
import { createMessagingBinding } from '../src/lib/messaging/handlers.ts';
import { createSessionScope } from '../src/lib/auth/session-scope.ts';

/* ============================================================
   The announcement
   ============================================================ */

test('a subscriber hears the sign-out, and stops hearing after it unsubscribes', () => {
	const heard = [];
	const unsubscribe = onSessionChange((change) => heard.push(change));

	notifySessionChange('signed-out');
	notifySessionChange('signed-in');
	unsubscribe();
	notifySessionChange('signed-out');

	assert.deepEqual(heard, ['signed-out', 'signed-in']);
	assert.equal(sessionChangeListenerCount(), 0, 'unsubscribe must actually detach');
});

test('one subscriber throwing does not strand the next one holding a socket', () => {
	// The reason the walk is defensive: these are teardown paths. A component
	// that fails to clean up must not prevent the component after it from
	// closing an authorized connection.
	const heard = [];
	const first = onSessionChange(() => {
		throw new Error('this subscriber is broken');
	});
	const second = onSessionChange((change) => heard.push(change));

	notifySessionChange('signed-out');
	first();
	second();

	assert.deepEqual(heard, ['signed-out']);
});

test('a subscriber that unsubscribes itself mid-announcement does not skip the next one', () => {
	// A component tearing itself down on sign-out is exactly this case.
	const heard = [];
	let dropSelf;
	dropSelf = onSessionChange(() => {
		heard.push('first');
		dropSelf();
	});
	const second = onSessionChange(() => heard.push('second'));

	notifySessionChange('signed-out');
	second();

	assert.deepEqual(heard, ['first', 'second']);
});

/* ============================================================
   The binding, driven with a fake socket
   ============================================================ */

/** Minimal WebSocket stand-in; the same shape `timeline-subscription` drives. */
class FakeSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	constructor(url, protocols) {
		this.url = url;
		this.protocols = protocols;
		this.readyState = FakeSocket.OPEN;
		this.sent = [];
		this.closed = false;
	}

	send(data) {
		this.sent.push(JSON.parse(data));
	}

	close() {
		this.closed = true;
		this.readyState = FakeSocket.CLOSED;
	}

	open() {
		this.onopen?.();
	}
	deliver(message) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	/** A conversation event, in the shape lesser publishes one. */
	publish(id) {
		this.deliver({ type: 'next', id: '1', payload: { data: { conversationUpdates: { id } } } });
	}
}

function conversation(id) {
	return {
		id,
		unread: true,
		unreadCount: 1,
		createdAt: '2026-07-01T09:00:00Z',
		updatedAt: '2026-07-01T10:00:00Z',
		accounts: [
			{ id: '/users/ada', username: 'ada', domain: null, displayName: 'Ada', avatar: null },
		],
		lastStatus: {
			id: `${id}-message`,
			content: '<p>hello</p>',
			createdAt: '2026-07-01T10:00:00Z',
			sensitive: false,
			spoilerText: null,
			actor: { id: '/users/ada', username: 'ada', domain: null, displayName: 'Ada', avatar: null },
			attachments: [],
		},
		viewerMetadata: {
			requestState: 'ACCEPTED',
			requestedAt: null,
			acceptedAt: '2026-07-01T09:30:00Z',
			declinedAt: null,
		},
	};
}

/** Let every queued microtask and timer callback run. */
const settle = async (turns = 4) => {
	for (let index = 0; index < turns; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

/**
 * A binding wired to a fake socket and a stubbed `fetch`, with everything it
 * reported recorded. `respond` may return a promise, which is what lets a probe
 * hold a re-read open across a teardown.
 */
function startBinding({
	respond = () => ({ data: { conversation: null } }),
	token = 'token-1',
	onPartial,
	// Injected by default so these probes drive the socket path without the
	// page-load InstanceInfo cache crossing tests. `resolver: null` selects the
	// production default — the cached anonymous read of what lesser serves —
	// and is what the instance-read probe below uses.
	resolver = async () => 'wss://realtime.contentus.test',
} = {}) {
	const sockets = [];
	const requests = [];
	const realtimeStates = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		const request = {
			operation:
				/(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '',
			variables: payload.variables ?? {},
			authorization: new Headers(init.headers).get('authorization'),
			signal: init.signal ?? null,
		};
		requests.push(request);
		const envelope = (await respond(request)) ?? { data: null };
		return new Response(JSON.stringify(envelope), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	const binding = createMessagingBinding({
		accessToken: () => token,
		...(resolver ? { resolveSubscriptionEndpoint: resolver } : {}),
		onRealtimeState: (state) => realtimeStates.push(state),
		...(onPartial ? { onPartial } : {}),
		socketFactory: (url, protocols) => {
			const socket = new FakeSocket(url, protocols);
			sockets.push(socket);
			return socket;
		},
	});

	return {
		binding,
		sockets,
		requests,
		realtimeStates,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

/** Subscribe the way the vendored context does, recording what it was told. */
async function subscribe(binding) {
	const statuses = [];
	const updates = [];
	const stop = binding.handlers.onSubscribeToConversationUpdates({
		onConversationUpdate: (update) => updates.push(update),
		onConnectionStatusChange: (status, reason) => statuses.push({ status, reason }),
	});
	// The socket endpoint is RESOLVED now — lesser v1.6.4 serves it, so the
	// answer is a promise — and the socket does not exist synchronously the way
	// it did when the host was a derived config value. Settle before handing
	// back: probes drive `sockets[0]` immediately after this returns.
	await settle();
	return { stop, statuses, updates };
}

test('signing out closes the socket and ends the stream', async () => {
	const probe = startBinding({
		respond: ({ variables }) => ({ data: { conversation: conversation(variables.id) } }),
	});

	try {
		const { updates } = await subscribe(probe.binding);
		probe.sockets[0].open();
		probe.sockets[0].deliver({ type: 'connection_ack' });
		probe.sockets[0].publish('conv-1');
		await settle();

		// The baseline: while the session is live, an event IS delivered. Without
		// this the assertions below would pass over a binding that never worked.
		assert.equal(probe.requests.length, 1, 'a live event should be re-read');
		assert.equal(updates.length, 1, 'a live event should reach the context');
		assert.equal(probe.sockets[0].closed, false);

		// Sign-out.
		probe.binding.teardown();

		assert.equal(probe.sockets[0].closed, true, 'the authorized socket must be closed');

		// And an event arriving after the reader has gone reaches nothing: no
		// authenticated read is issued for it, and nothing is handed to the
		// context that would put a body back on screen.
		probe.sockets[0].publish('conv-2');
		await settle();

		assert.equal(probe.requests.length, 1, 'a torn-down binding must issue no further reads');
		assert.equal(updates.length, 1, 'a torn-down binding must deliver no further updates');
	} finally {
		probe.restore();
	}
});

test('a re-read already in flight at sign-out delivers nothing when it lands', async () => {
	// The narrow window that matters most: the event arrived while the reader was
	// still signed in, and the answer arrives after they are not.
	const gates = [];
	const probe = startBinding({
		respond: (request) => new Promise((resolve) => gates.push({ request, resolve })),
	});

	try {
		const { updates } = await subscribe(probe.binding);
		probe.sockets[0].open();
		probe.sockets[0].deliver({ type: 'connection_ack' });
		probe.sockets[0].publish('conv-1');
		await settle();

		assert.equal(gates.length, 1, 'the re-read should be in flight');

		probe.binding.teardown();
		gates[0].resolve({ data: { conversation: conversation('conv-1') } });
		await settle();

		assert.equal(updates.length, 0, 'a read that resolves after sign-out must reach nothing');
	} finally {
		probe.restore();
	}
});

test('the next reader gets a new binding, and the previous one stays silent', async () => {
	const first = startBinding({
		respond: ({ variables }) => ({ data: { conversation: conversation(variables.id) } }),
		token: 'token-ada',
	});

	let second;
	try {
		const firstSubscription = await subscribe(first.binding);
		first.sockets[0].open();
		first.sockets[0].deliver({ type: 'connection_ack' });
		await settle();

		assert.deepEqual(
			first.sockets[0].sent[0]?.payload,
			{ Authorization: 'Bearer token-ada' },
			'the first session authorizes its own socket'
		);

		first.binding.teardown();
		first.restore();

		// A different account signs in on the same page: a NEW binding, which is
		// what `MessagesPage.closeSession`/`openSession` produce.
		second = startBinding({
			respond: ({ variables }) => ({ data: { conversation: conversation(variables.id) } }),
			token: 'token-bob',
		});
		const secondSubscription = await subscribe(second.binding);
		second.sockets[0].open();
		second.sockets[0].deliver({ type: 'connection_ack' });
		second.sockets[0].publish('conv-9');
		await settle();

		assert.deepEqual(
			second.sockets[0].sent[0]?.payload,
			{ Authorization: 'Bearer token-bob' },
			'the second session authorizes with its own token'
		);
		assert.equal(secondSubscription.updates.length, 1, 'the new session receives its own events');
		assert.equal(
			firstSubscription.updates.length,
			0,
			'nothing from the new session reaches the previous one'
		);
		assert.equal(
			second.requests.every((request) => request.authorization === 'Bearer token-bob'),
			true,
			'no read carries the previous session token'
		);
	} finally {
		second?.restore();
		first.restore();
	}
});

test('a torn-down binding opens no socket for a late subscribe', async () => {
	const probe = startBinding();
	try {
		probe.binding.teardown();
		const { statuses } = await subscribe(probe.binding);

		assert.equal(probe.sockets.length, 0, 'no socket may be opened after teardown');
		assert.equal(statuses.length, 0, 'and nothing is reported to a context that no longer exists');
	} finally {
		probe.restore();
	}
});

test('a binding torn down while the endpoint is still resolving opens no socket', async () => {
	// The endpoint is a promise now (lesser serves it), and the promise can land
	// AFTER the teardown: `teardown` stops every subscription through
	// `activeStops` while the ask is still in flight. The adapter's `stopped`
	// guard is what keeps that race from opening an authorized socket with
	// nothing left to read it.
	let release;
	const probe = startBinding({
		resolver: () =>
			new Promise((resolve) => {
				release = () => resolve('wss://realtime.contentus.test');
			}),
	});
	try {
		const pending = subscribe(probe.binding); // the resolution is deliberately held open
		probe.binding.teardown();
		release();
		await pending;

		assert.equal(probe.sockets.length, 0, 'a teardown mid-resolve must not open a socket afterwards');
	} finally {
		probe.restore();
	}
});

/** A full, valid `instance` answer, as lesser v1.6.4 serves one. */
function instancePayload() {
	return {
		subscriptionUrl: 'wss://served-by-lesser.invalid/graphql',
		maxUploadSizeBytes: 10485760,
		maxStatusCharacters: 5000,
		cmsFeatures: {
			longForm: true,
			drafts: true,
			revisions: true,
			scheduling: false,
			series: true,
			categories: true,
		},
	};
}

test('the default endpoint resolver reads the served InstanceInfo, once and anonymously', async () => {
	// No injected resolver: the production default asks lesser for
	// `InstanceInfo` through the page-load cache, and the socket goes to the URL
	// lesser SERVED — the wiring the injected-resolver probes above bypass.
	const probe = startBinding({
		resolver: null,
		respond: ({ operation }) =>
			operation === 'ContentusInstanceInfo'
				? { data: { instance: instancePayload() } }
				: { data: { conversation: null } },
	});
	try {
		await subscribe(probe.binding);

		assert.equal(
			probe.sockets[0]?.url,
			'wss://served-by-lesser.invalid/graphql',
			'the socket goes to the URL lesser served, not a derived host'
		);

		const instanceReads = () => probe.requests.filter((r) => r.operation === 'ContentusInstanceInfo');
		assert.equal(instanceReads().length, 1, 'the binding asked for the instance info');
		assert.equal(
			instanceReads()[0].authorization ?? null,
			null,
			'`instance` is a public field — no credential is attached, even here'
		);

		// A second subscription on the same page load does not ask again: the
		// timelines feed and this binding share the one read.
		await subscribe(probe.binding);
		assert.equal(instanceReads().length, 1, 'the page-load cache answers once');
	} finally {
		probe.restore();
	}
});

/* ============================================================
   In-flight HTTP reads end with the session too
   ============================================================ */

test('an in-flight folder read from the old session publishes nothing after sign-out', async () => {
	// H1's surviving half: the socket teardown is synchronous, but a LIST read
	// already dispatched resolves whenever it resolves. Hold it, sign out,
	// release it — the answer must not reach the state the next session renders.
	const gates = [];
	const partials = [];
	const probe = startBinding({
		respond: (request) => new Promise((resolve) => gates.push({ request, resolve })),
		onPartial: (operation) => partials.push(operation),
	});

	try {
		const outcome = probe.binding.handlers.onFetchConversations('INBOX').then(
			() => 'resolved',
			(error) =>
				error instanceof Error && /session ended/i.test(error.message) ? 'dropped' : error
		);
		await settle();
		assert.equal(gates.length, 1, 'the folder read is in flight');

		probe.binding.teardown();

		assert.equal(
			probe.requests[0].signal?.aborted,
			true,
			'teardown cancels the request itself where the transport allows it'
		);

		// The answer lands anyway — with data AND an error, the partial shape —
		// for a session that no longer exists.
		gates[0].resolve({
			data: {
				conversationConnection: {
					edges: [{ cursor: 'conv-ada-cursor', node: conversation('conv-ada') }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
			errors: [{ message: 'partial failure' }],
		});
		await settle();

		assert.equal(
			await outcome,
			'dropped',
			"a list read that resolves after sign-out must not resolve into the new session's state"
		);
		assert.deepEqual(partials, [], 'and its partial notice must not be published either');
	} finally {
		probe.restore();
	}
});

test('an in-flight thread page from the old session delivers nothing after sign-out', async () => {
	// Same race, one level down: the open thread's own read.
	const gates = [];
	const probe = startBinding({
		respond: (request) => new Promise((resolve) => gates.push({ request, resolve })),
	});

	try {
		const outcome = probe.binding.loadMessagePage('conv-1').then(
			() => 'resolved',
			(error) =>
				error instanceof Error && /session ended/i.test(error.message) ? 'dropped' : error
		);
		await settle();
		assert.equal(gates.length, 1);

		probe.binding.teardown();
		gates[0].resolve({
			data: {
				conversationMessages: {
					edges: [],
					pageInfo: { hasNextPage: false, endCursor: null },
					totalCount: 0,
				},
			},
		});
		await settle();

		assert.equal(await outcome, 'dropped');
	} finally {
		probe.restore();
	}
});

test('a count read for a session that ended before it landed is dropped', async () => {
	// The badge's race — the one no binding teardown can reach, because the
	// store outlives every binding it creates. Driven through the REAL session
	// announcement and the REAL scope shape `unread.svelte.ts` stamps with:
	// hold A's refresh, sign out, sign in as B, release A — A's resolution
	// names a dead generation, and only B's own read still holds.
	const scope = createSessionScope(sessionGeneration);
	const adaRefresh = scope.stamp();

	notifySessionChange('signed-out');
	assert.equal(scope.holds(adaRefresh), false, 'a read spanning the sign-out names a dead session');

	notifySessionChange('signed-in');
	const bobRefresh = scope.stamp();
	assert.equal(scope.holds(adaRefresh), false, '…and the sign-in does not resurrect it');
	assert.equal(
		scope.holds(bobRefresh),
		true,
		"the new session's own read, stamped now, is the one that may publish"
	);
});

test('the badge stamps its count read with the session generation', () => {
	// STRUCTURAL. `unread.svelte.ts` imports `$lib/auth/session`, which imports
	// `$app/environment` — unloadable here, so the wiring is asserted on the
	// source, the same way `clearSession`'s announcement is below.
	const source = readFileSync('src/lib/messaging/unread.svelte.ts', 'utf8');

	assert.match(
		source,
		/createSessionScope\(sessionGeneration\)/,
		'the badge must stamp its reads against the global session generation'
	);
	assert.match(source, /#scope\.stamp\(\)/, 'the stamp is taken at dispatch');
	assert.match(source, /#scope\.holds\(/, 'and checked before anything publishes');
});

/* ============================================================
   The wiring, read off the parsed components
   ============================================================ */

/** Every node in a Svelte/ESTree tree, depth first. */
function* walk(node) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) yield* walk(item);
		return;
	}
	yield node;
	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent' || key === 'loc') continue;
		yield* walk(value);
	}
}

function parseComponent(path) {
	return parse(readFileSync(path, 'utf8'), { modern: true });
}

/** Whether the parsed program calls `name(...)` anywhere. */
function calls(ast, name) {
	for (const node of walk(ast)) {
		if (node.type !== 'CallExpression') continue;
		const callee = node.callee;
		if (callee?.type === 'Identifier' && callee.name === name) return true;
		if (callee?.type === 'MemberExpression' && callee.property?.name === name) return true;
	}
	return false;
}

test('the messages gate subscribes to the session and tears the binding down', () => {
	// STRUCTURAL, not behavioural: this reads the component's parsed instance
	// script rather than mounting it, because the repo has no DOM harness. What
	// it proves is that the wiring the tests above exercise is actually present
	// in the component — the piece a module-level probe cannot reach.
	const ast = parseComponent('src/lib/messaging/MessagesPage.svelte');

	assert.ok(
		calls(ast.instance, 'onSessionChange'),
		'MessagesPage must track the session rather than snapshot it at mount'
	);
	assert.ok(
		calls(ast.instance, 'teardown'),
		'MessagesPage must tear the binding down — that is what closes the socket'
	);
	assert.ok(
		calls(ast.instance, 'reset'),
		'MessagesPage must reset the unread store when the session ends'
	);
});

test('the shell announces the sign-out rather than only clearing storage', () => {
	const ast = parseComponent('src/lib/shell/AppShell.svelte');

	assert.ok(calls(ast.instance, 'clearSession'), 'the shell should still clear the session');
	assert.ok(
		calls(ast.instance, 'onSessionChange'),
		'the shell must react to a session ending anywhere, not only to its own button'
	);
});

test('clearing the session announces it', () => {
	// The link between the two: `clearSession` is what the shell calls, and the
	// announcement is what every other surface acts on. Asserted on the parsed
	// module rather than by importing it — `$lib/auth/session` imports
	// `$app/environment`, which `node --test` cannot resolve.
	const source = readFileSync('src/lib/auth/session.ts', 'utf8');
	const clear = source.slice(source.indexOf('export function clearSession'));
	const body = clear.slice(0, clear.indexOf('\n}'));

	assert.match(
		body,
		/notifySessionChange\('signed-out'\)/,
		'clearSession must announce the sign-out; emptying storage does nothing to a running page'
	);
});
