/**
 * Face 4's realtime-transport probes.
 *
 * `src/lib/timelines/subscription.ts` implements lesser's documented
 * `graphql-transport-ws` framing by hand, so every claim the module makes about
 * that protocol has to be checked here rather than trusted. A transport nobody
 * drove is a transport nobody knows the shape of.
 *
 * The socket is injected, so these run with no network and no browser: the fake
 * below records what was SENT, which is the half most invisible in production.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	GRAPHQL_TRANSPORT_WS,
	subscribe,
	subscriptionEndpoint,
} from '../src/lib/timelines/subscription.ts';

/** Minimal WebSocket stand-in with the constants the module reads. */
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

	// Drivers.
	open() {
		this.onopen?.();
	}
	deliver(message) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	drop() {
		this.onclose?.();
	}
}

/** Start a subscription against a fake socket and return both plus the state log. */
function start(options = {}) {
	let socket;
	const states = [];
	const received = [];

	const stop = subscribe({
		endpoint: 'wss://ws.example.test',
		query: 'subscription X { timelineUpdates(type: PUBLIC) { id } }',
		variables: { type: 'PUBLIC' },
		onState: (state) => states.push(state),
		onData: (data) => received.push(data),
		socketFactory: (url, protocols) => {
			socket = new FakeSocket(url, protocols);
			return socket;
		},
		...options,
	});

	return { socket, states, received, stop };
}

// The module reads `WebSocket.OPEN`; in Node there is no global WebSocket
// constant with the same identity as the fake, so the fake supplies it.
globalThis.WebSocket = globalThis.WebSocket ?? FakeSocket;

/* ---------------------------------------------------------------------------
 * Endpoint derivation
 * ------------------------------------------------------------------------ */

test('the subscription host is derived by prefixing ws. onto the served origin', () => {
	// lesser serves GraphQL subscriptions from `wss://ws.<stage-domain>`. No
	// instance domain is hard-coded anywhere; the host comes from the request.
	assert.equal(subscriptionEndpoint('https://social.example.test'), 'wss://ws.social.example.test');
	assert.equal(
		subscriptionEndpoint('https://trenchcoat.lesser.host'),
		'wss://ws.trenchcoat.lesser.host'
	);
});

test('an http origin maps to ws, and a port survives', () => {
	assert.equal(subscriptionEndpoint('http://localhost:5173'), 'ws://ws.localhost:5173');
});

test('an origin that is already a ws host does not get a second prefix', () => {
	assert.equal(subscriptionEndpoint('https://ws.example.test'), 'wss://ws.example.test');
});

test('an unusable origin yields null rather than a fabricated URL', () => {
	// The null is load-bearing: callers degrade to "live updates unavailable",
	// which is honest, where a guessed URL produces a failure a reader cannot act
	// on. `resolveRequestOrigin` already fails closed for the same reason.
	for (const bad of [null, undefined, '', 'not a url', '://missing-scheme']) {
		assert.equal(subscriptionEndpoint(bad), null, `${JSON.stringify(bad)} must not produce a URL`);
	}
});

/* ---------------------------------------------------------------------------
 * The protocol lesser documents
 * ------------------------------------------------------------------------ */

test('the socket negotiates the graphql-transport-ws subprotocol', () => {
	const { socket } = start();
	assert.equal(socket.protocols, GRAPHQL_TRANSPORT_WS);
	assert.equal(
		GRAPHQL_TRANSPORT_WS,
		'graphql-transport-ws',
		"lesser's cmd/graphql-ws negotiates this exact name"
	);
});

test('auth travels in connection_init, never in the URL', () => {
	// lesser ignores query-string tokens for GraphQL subscriptions, and a token
	// in a URL lands in logs and proxy history besides.
	const { socket } = start({ accessToken: 'token-abc' });
	socket.open();

	const init = socket.sent.find((message) => message.type === 'connection_init');
	assert.ok(init, 'connection_init must be the first frame');
	assert.equal(init.payload.Authorization, 'Bearer token-abc');
	assert.ok(!socket.url.includes('token-abc'), 'the token must not appear in the URL');
	assert.ok(!socket.url.includes('access_token'));
});

test('an anonymous subscription sends an empty init payload, not a fake token', () => {
	const { socket } = start({ accessToken: null });
	socket.open();

	const init = socket.sent.find((message) => message.type === 'connection_init');
	assert.deepEqual(init.payload, {});
});

test('the subscribe frame waits for connection_ack', () => {
	const { socket, states } = start();
	socket.open();

	assert.ok(
		!socket.sent.some((message) => message.type === 'subscribe'),
		'subscribing before the ack is a protocol violation'
	);

	socket.deliver({ type: 'connection_ack' });

	const sub = socket.sent.find((message) => message.type === 'subscribe');
	assert.ok(sub, 'the subscribe frame follows the ack');
	assert.equal(sub.payload.variables.type, 'PUBLIC');
	assert.match(sub.payload.query, /timelineUpdates/);
	assert.deepEqual(states, ['connecting', 'live']);
});

test('a ping is answered with a pong carrying the same payload', () => {
	const { socket } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({ type: 'ping', payload: { keepalive: 1 } });

	const pong = socket.sent.find((message) => message.type === 'pong');
	assert.ok(pong, 'an unanswered ping is a closed connection');
	assert.deepEqual(pong.payload, { keepalive: 1 });
});

test('next frames deliver data, and a next carrying only errors delivers nothing', () => {
	const { socket, received } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	socket.deliver({
		type: 'next',
		id: '1',
		payload: { data: { timelineUpdates: { id: 'obj-1' } } },
	});
	assert.equal(received.length, 1);
	assert.equal(received[0].timelineUpdates.id, 'obj-1');

	// A field failure is not a post; passing it on would prepend an empty card.
	socket.deliver({ type: 'next', id: '1', payload: { errors: [{ message: 'boom' }] } });
	assert.equal(received.length, 1);
});

test('frames for another subscription id are ignored', () => {
	const { socket, received } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({ type: 'next', id: '99', payload: { data: { timelineUpdates: { id: 'x' } } } });

	assert.equal(received.length, 0);
});

test('an unparseable frame does not tear down a working stream', () => {
	const { socket, received, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	socket.onmessage({ data: 'not json at all' });
	assert.ok(!socket.closed, 'the protocol tolerates unknown messages');

	socket.deliver({
		type: 'next',
		id: '1',
		payload: { data: { timelineUpdates: { id: 'obj-2' } } },
	});
	assert.equal(received.length, 1, 'and the stream keeps working after one');
	assert.equal(states.at(-1), 'live');
});

/* ---------------------------------------------------------------------------
 * Failure states, which are different screens
 * ------------------------------------------------------------------------ */

test("lesser's auth refusal is reported as requires-auth, not as a generic failure", () => {
	// The subscription resolver refuses every type but PUBLIC without a token.
	// That state has an action attached — sign in — so it must not collapse into
	// "something went wrong".
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({
		type: 'error',
		id: '1',
		payload: [{ message: 'authentication required for this timeline type' }],
	});

	assert.equal(states.at(-1), 'requires-auth');
	assert.ok(socket.closed);
});

test('any other error is unavailable, and a dropped socket is too', () => {
	const errored = start();
	errored.socket.open();
	errored.socket.deliver({ type: 'connection_ack' });
	errored.socket.deliver({ type: 'error', id: '1', payload: [{ message: 'internal failure' }] });
	assert.equal(errored.states.at(-1), 'unavailable');

	const dropped = start();
	dropped.socket.open();
	dropped.socket.deliver({ type: 'connection_ack' });
	dropped.socket.drop();
	assert.equal(dropped.states.at(-1), 'unavailable');
});

test('a dropped socket is NOT silently reconnected', () => {
	// Silent reconnection leaves a gap nothing marks: the posts published while
	// the socket was down never arrive, and the timeline looks continuous while
	// missing them. Recovery is the reader's visible refresh instead.
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	const sentBefore = socket.sent.length;

	socket.drop();

	assert.equal(states.at(-1), 'unavailable');
	assert.equal(socket.sent.length, sentBefore, 'nothing may be re-sent on the dead socket');
	assert.ok(
		!states.slice(states.indexOf('live') + 1).includes('connecting'),
		'no reconnection attempt may follow a drop'
	);
});

test('a socket that cannot be constructed becomes unavailable rather than throwing', () => {
	const states = [];
	const stop = subscribe({
		endpoint: 'wss://ws.example.test',
		query: 'subscription X { timelineUpdates(type: PUBLIC) { id } }',
		onState: (state) => states.push(state),
		onData: () => {},
		socketFactory: () => {
			throw new Error('blocked by CSP');
		},
	});

	assert.deepEqual(states, ['unavailable']);
	assert.equal(typeof stop, 'function', 'the caller still gets a teardown it can call safely');
	stop();
});

/* ---------------------------------------------------------------------------
 * Teardown
 * ------------------------------------------------------------------------ */

test('stopping sends complete and closes exactly once', () => {
	const { socket, states, stop } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	stop();

	assert.ok(socket.sent.some((message) => message.type === 'complete'));
	assert.ok(socket.closed);
	assert.equal(states.at(-1), 'idle');

	const afterFirstStop = socket.sent.length;
	stop();
	assert.equal(socket.sent.length, afterFirstStop, 'a second stop is a no-op');
});

test("lesser's own complete ends the stream without an error state", () => {
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({ type: 'complete', id: '1' });

	assert.equal(states.at(-1), 'idle', 'a clean end is not a failure');
	assert.ok(socket.closed);
});
