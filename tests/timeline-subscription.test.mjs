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
	CLOSE_ACK_TIMEOUT,
	CLOSE_INVALID_FRAME,
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
		/** Every close code the module passed, in order. */
		this.closeCodes = [];
	}

	send(data) {
		this.sent.push(JSON.parse(data));
	}

	close(code, reason) {
		this.closed = true;
		this.closeCodes.push(code ?? null);
		this.closeReason = reason ?? null;
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

/**
 * Start a subscription against a fake socket and return both plus the state log.
 *
 * The ack deadline is DRIVEN, not waited out: `fireAckTimeout()` runs whatever
 * the module scheduled. A timeout asserted by sleeping is a timeout asserted
 * flakily, and one asserted not at all is the finding this file was reworked for.
 */
function start(options = {}) {
	let socket;
	const states = [];
	const received = [];
	const timers = [];

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
		scheduleTimeout: (run, ms) => {
			const timer = { run, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		...options,
	});

	const fireAckTimeout = () => {
		for (const timer of timers) if (!timer.cancelled) timer.run();
	};

	return { socket, states, received, stop, timers, fireAckTimeout };
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

test('next frames deliver data, and a next carrying only errors is reported as degraded', () => {
	const { socket, received, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	socket.deliver({
		type: 'next',
		id: '1',
		payload: { data: { timelineUpdates: { id: 'obj-1' } } },
	});
	assert.equal(received.length, 1);
	assert.equal(received[0].timelineUpdates.id, 'obj-1');
	assert.equal(states.at(-1), 'live');

	// A field failure is not a post; passing it on would prepend an empty card.
	// But it is not nothing either — lesser published something that did not
	// arrive, and a strip still reading `live` would be claiming a continuity
	// this stream just lost. That silent drop is what this assertion replaced.
	socket.deliver({ type: 'next', id: '1', payload: { errors: [{ message: 'boom' }] } });
	assert.equal(received.length, 1, 'still no empty card');
	assert.equal(states.at(-1), 'degraded');
	assert.ok(!socket.closed, 'and the socket stays open, because the stream has not ended');
});

test('frames for another subscription id are ignored', () => {
	const { socket, received } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({ type: 'next', id: '99', payload: { data: { timelineUpdates: { id: 'x' } } } });

	assert.equal(received.length, 0);
});

test('an unparseable frame terminates the session with 4400, as the spec requires', () => {
	// This assertion is the inverse of the one it replaces, and the replacement
	// is the point. The old probe asserted that a frame this client could not
	// parse was IGNORED and the stream carried on reading `live` — which is a
	// session whose peers have disagreed about the protocol, reported to the
	// reader as healthy. `graphql-transport-ws` requires 4400 termination.
	const { socket, received, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	socket.onmessage({ data: 'not json at all' });

	assert.ok(socket.closed, 'an invalid frame ends the session');
	assert.deepEqual(socket.closeCodes, [CLOSE_INVALID_FRAME]);
	assert.equal(states.at(-1), 'unavailable', 'and the reader is told, rather than left on live');

	// Nothing after the teardown may still be treated as stream traffic.
	socket.deliver({
		type: 'next',
		id: '1',
		payload: { data: { timelineUpdates: { id: 'obj-2' } } },
	});
	assert.equal(received.length, 0);
});

test('a well-formed frame that is not an object is invalid too', () => {
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	// Valid JSON, no message shape. `"type" of undefined` is not a protocol.
	socket.onmessage({ data: '[1,2,3]' });

	assert.deepEqual(socket.closeCodes, [CLOSE_INVALID_FRAME]);
	assert.equal(states.at(-1), 'unavailable');
});

test('an unprompted pong is ignored rather than treated as a failure', () => {
	// This client sends no `ping`, so a keepalive `pong` is traffic to skip. It
	// is named explicitly because the invalid-frame rule above must not be
	// widened into "any frame I did not expect ends the session" — lesser
	// already sends one non-spec frame, and a strict unknown-type teardown would
	// close on its own gateway's legacy vocabulary.
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({ type: 'pong' });

	assert.ok(!socket.closed);
	assert.equal(states.at(-1), 'live');
});

/* ---------------------------------------------------------------------------
 * Failure states, which are different screens
 * ------------------------------------------------------------------------ */

test("lesser's gateway refuses a tokenless connection_init, and that must not be a stall", () => {
	// THE FINDING THIS EXISTS FOR. `cmd/graphql-ws/main.go` → `handleConnectionInit`
	// answers an empty init payload with `connection_error` — before any GraphQL
	// dispatch, and WITHOUT closing the socket. A client with no case for that
	// frame waits on an ack that will never arrive, so the live strip read
	// "Connecting…" forever: the one outcome a reader can neither read nor act on.
	//
	// `connection_error` is not a `graphql-transport-ws` frame at all; it belongs
	// to the older `subscriptions-transport-ws` protocol. It is handled because it
	// is what the instance sends, not because the protocol says to.
	const { socket, states } = start({ accessToken: null });
	socket.open();

	socket.deliver({
		type: 'connection_error',
		payload: { message: 'Access token required in connection_init payload', code: 'unauthorized' },
	});

	assert.equal(states.at(-1), 'requires-auth', 'a refusal with an action attached says so');
	assert.ok(!states.includes('live'), 'and never claims the stream opened');
	assert.ok(socket.closed, 'the session is closed rather than left waiting on an ack');
});

test('an expired token gets the same treatment, from the same frame', () => {
	// The other `connection_error` the gateway sends. Identical shape, identical
	// consequence for a reader: sign in again.
	const { socket, states } = start({ accessToken: 'stale-token' });
	socket.open();

	socket.deliver({
		type: 'connection_error',
		payload: { message: 'Invalid or expired token', code: 'unauthorized' },
	});

	assert.equal(states.at(-1), 'requires-auth');
	assert.ok(socket.closed);
});

test('a connection_error with no auth vocabulary is unavailable, and still terminal', () => {
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_error', payload: { message: 'gateway exploded' } });

	assert.equal(states.at(-1), 'unavailable');
	assert.ok(socket.closed, 'unclassifiable is still not a reason to keep spinning');
});

test('a handshake that is never acknowledged times out instead of spinning', () => {
	const { socket, states, fireAckTimeout } = start();
	socket.open();

	assert.equal(states.at(-1), 'connecting', 'the deadline has not passed yet');
	fireAckTimeout();

	assert.equal(states.at(-1), 'unavailable');
	assert.deepEqual(socket.closeCodes, [CLOSE_ACK_TIMEOUT]);
});

test('the ack cancels the deadline, so a healthy stream is never torn down by it', () => {
	const { socket, states, timers, fireAckTimeout } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });

	assert.ok(
		timers.every((timer) => timer.cancelled),
		'the deadline must be cancelled the moment the ack lands'
	);

	fireAckTimeout();
	assert.equal(states.at(-1), 'live', 'a live stream stays live');
	assert.ok(!socket.closed);
});

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

test("lesser's own complete ends the stream in a state that renders copy", () => {
	// Replaces an assertion on `idle`. `idle` is the state the TEARDOWN path
	// uses — the reader navigated away — and the live strip deliberately renders
	// nothing for it. Mapping a SERVER-initiated end onto it left a strip that
	// said nothing at all while posts had stopped arriving. lesser sends
	// `complete` on several refusal paths (`handleSubscribe` emits it after every
	// `error`), so this is a frame readers actually meet.
	const { socket, states } = start();
	socket.open();
	socket.deliver({ type: 'connection_ack' });
	socket.deliver({ type: 'complete', id: '1' });

	assert.equal(states.at(-1), 'unavailable', 'the stream stopped, and the reader is told so');
	assert.ok(!states.slice(states.indexOf('live')).includes('idle'), 'never the blank state');
	assert.ok(socket.closed);
});

test('every terminal frame leaves a state a reader can act on — none leaves connecting', () => {
	// The property behind the four probes above, asserted as a property. Any
	// future refusal frame that lands with no case will fail here rather than
	// shipping as a spinner.
	const terminals = [
		{
			type: 'connection_error',
			payload: { message: 'Access token required', code: 'unauthorized' },
		},
		{ type: 'connection_error', payload: { message: 'gateway exploded' } },
		{ type: 'error', id: '1', payload: [{ message: 'authentication required' }] },
		{ type: 'error', id: '1', payload: [{ message: 'internal failure' }] },
		{ type: 'complete', id: '1' },
	];

	for (const frame of terminals) {
		const { socket, states } = start();
		socket.open();
		if (frame.id) socket.deliver({ type: 'connection_ack' });
		socket.deliver(frame);

		assert.ok(
			['requires-auth', 'unavailable'].includes(states.at(-1)),
			`${frame.type} left the reader on "${states.at(-1)}"`
		);
		assert.ok(socket.closed, `${frame.type} left the socket open`);
	}
});
