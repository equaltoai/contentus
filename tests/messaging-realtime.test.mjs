/**
 * What the realtime binding does about gaps and failures — driven, not assumed.
 *
 * TWO DEFECTS THIS FILE PINS.
 *
 *   1. **A reconnect advertised "live" over a gap.** `conversationUpdates` has
 *      no replay, and the transport deliberately refuses to reconnect silently
 *      for exactly that reason (`timelines/subscription.ts`) — but the vendored
 *      context reconnects on every error, and the binding reported `connected`
 *      the moment the new socket acked. Everything published while the socket
 *      was down had not arrived and never would, and nothing on screen said so.
 *   2. **Every id-only event launched an unbounded re-read, and failures were
 *      swallowed.** One `fetchConversation` per event, with no per-id collapse
 *      and an empty `catch`: a correspondent typing quickly became a fan-out of
 *      concurrent authenticated reads whose completion order decided which one
 *      wrote `lastStatus`, and an expired session dropped on the floor while the
 *      socket went on reporting live.
 *
 * Everything below drives the REAL binding — the shipped `createMessagingBinding`
 * over the shipped adapter — with a fake socket and a stubbed `fetch`, and reads
 * the states it actually reported. The socket is injected rather than emulated,
 * so no test here waits on a timer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMessagingBinding } from '../src/lib/messaging/handlers.ts';
import { isLive, realtimeNotice } from '../src/lib/messaging/liveness.ts';

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
	drop() {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}
	publish(id) {
		this.deliver({ type: 'next', id: '1', payload: { data: { conversationUpdates: { id } } } });
	}
	live() {
		this.open();
		this.deliver({ type: 'connection_ack' });
	}
}

function conversation(id, updatedAt = '2026-07-01T10:00:00Z') {
	return {
		id,
		unread: true,
		createdAt: '2026-07-01T09:00:00Z',
		updatedAt,
		accounts: [
			{ id: '/users/ada', username: 'ada', domain: null, displayName: 'Ada', avatar: null },
		],
		lastStatus: {
			id: `${id}@${updatedAt}`,
			content: '<p>hello</p>',
			createdAt: updatedAt,
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

const settle = async (turns = 4) => {
	for (let index = 0; index < turns; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

function startBinding({ respond = () => ({ data: { conversation: null } }) } = {}) {
	const sockets = [];
	const requests = [];
	const realtimeStates = [];
	const catchUps = [];
	const rereads = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		const request = {
			operation:
				/(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '',
			variables: payload.variables ?? {},
		};
		requests.push(request);
		const envelope = (await respond(request)) ?? { data: null };
		return new Response(JSON.stringify(envelope), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	const binding = createMessagingBinding({
		accessToken: () => 'token-abc',
		origin: 'https://contentus.test',
		onRealtimeState: (state) => realtimeStates.push(state),
		onCatchUp: (state) => catchUps.push(state),
		onRereadState: (state) => rereads.push(state),
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
		catchUps,
		rereads,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

/** Subscribe the way the vendored context does, recording what it was told. */
function subscribe(binding) {
	const statuses = [];
	const updates = [];
	const stop = binding.handlers.onSubscribeToConversationUpdates({
		onConversationUpdate: (update) => updates.push(update),
		onConnectionStatusChange: (status, reason) => statuses.push({ status, reason }),
	});
	return { stop, statuses, updates, reported: () => statuses.map((entry) => entry.status) };
}

/* ============================================================
   Reconnect: the gap is closed before "live" is claimed
   ============================================================ */

test('the first live connection is reported without a re-read behind it', async () => {
	// `Root` loads the folder as it mounts, and that read IS the baseline. A
	// reconciliation here would be a second identical request on every page load.
	const probe = startBinding();
	let reconciled = 0;
	probe.binding.setReconciler(async () => {
		reconciled += 1;
	});

	try {
		const subscription = subscribe(probe.binding);
		probe.sockets[0].live();
		await settle();

		assert.deepEqual(subscription.reported(), ['connecting', 'connected']);
		assert.equal(reconciled, 0);
		assert.deepEqual(probe.catchUps.at(-1), 'idle');
	} finally {
		probe.restore();
	}
});

test('a reconnect says "catching up" and does not say "live" until it has', async () => {
	const probe = startBinding();
	let release;
	let reconciled = 0;
	probe.binding.setReconciler(() => {
		reconciled += 1;
		return new Promise((resolve) => {
			release = resolve;
		});
	});

	try {
		const first = subscribe(probe.binding);
		probe.sockets[0].live();
		await settle();
		assert.deepEqual(first.reported(), ['connecting', 'connected']);

		// The socket drops and the context re-subscribes — its own behaviour, and
		// the behaviour that made the gap invisible.
		probe.sockets[0].drop();
		first.stop();

		const second = subscribe(probe.binding);
		probe.sockets[1].live();
		await settle();

		assert.equal(reconciled, 1, 'a reconnect must re-read what the drop missed');
		assert.equal(probe.catchUps.at(-1), 'catching-up');
		assert.ok(
			!second.reported().includes('connected'),
			'the connection must not be reported live while the gap is still open'
		);

		release();
		await settle();

		assert.equal(second.reported().at(-1), 'connected');
		assert.equal(probe.catchUps.at(-1), 'idle');
	} finally {
		probe.restore();
	}
});

test('a reconciliation that fails is named, not quietly dropped', async () => {
	const probe = startBinding();
	probe.binding.setReconciler(async () => {
		throw new Error('This instance did not answer the request for your conversations.');
	});

	try {
		const first = subscribe(probe.binding);
		probe.sockets[0].live();
		await settle();
		first.stop();

		subscribe(probe.binding);
		probe.sockets[1].live();
		await settle();

		assert.deepEqual(probe.catchUps.slice(-2), ['catching-up', 'failed']);
		// And the reader is told, in the words the surface renders.
		assert.match(
			realtimeNotice({ socket: 'live', catchUp: 'failed', reread: 'idle' }).text,
			/could not be loaded/
		);
	} finally {
		probe.restore();
	}
});

test('a reconnect with nothing registered to re-read with does not claim reconciliation', async () => {
	const probe = startBinding();

	try {
		const first = subscribe(probe.binding);
		probe.sockets[0].live();
		await settle();
		first.stop();

		subscribe(probe.binding);
		probe.sockets[1].live();
		await settle();

		assert.equal(probe.catchUps.at(-1), 'failed');
	} finally {
		probe.restore();
	}
});

/* ============================================================
   Bursts: bounded, ordered, and never silent
   ============================================================ */

test('a burst of events for one conversation collapses into a bounded number of reads', async () => {
	const gates = [];
	const probe = startBinding({
		respond: (request) => new Promise((resolve) => gates.push({ request, resolve })),
	});

	try {
		subscribe(probe.binding);
		probe.sockets[0].live();

		for (let index = 0; index < 5; index += 1) probe.sockets[0].publish('conv-1');
		await settle();

		assert.equal(probe.requests.length, 1, 'one read per conversation is in flight at a time');

		gates[0].resolve({ data: { conversation: conversation('conv-1', '2026-07-01T10:05:00Z') } });
		await settle();

		assert.equal(
			probe.requests.length,
			2,
			'five events collapse to the read in flight plus one trailing read'
		);

		gates[1].resolve({ data: { conversation: conversation('conv-1', '2026-07-01T10:06:00Z') } });
		await settle();

		assert.equal(probe.requests.length, 2, 'and the trailing read is not itself re-issued');
	} finally {
		probe.restore();
	}
});

test('the trailing read is issued last, so the newest state is the one that lands', async () => {
	const gates = [];
	const probe = startBinding({
		respond: (request) => new Promise((resolve) => gates.push({ request, resolve })),
	});

	try {
		const subscription = subscribe(probe.binding);
		probe.sockets[0].live();

		probe.sockets[0].publish('conv-1');
		await settle();
		probe.sockets[0].publish('conv-1');
		await settle();

		gates[0].resolve({ data: { conversation: conversation('conv-1', '2026-07-01T10:01:00Z') } });
		await settle();
		gates[1].resolve({ data: { conversation: conversation('conv-1', '2026-07-01T10:09:00Z') } });
		await settle();

		assert.deepEqual(
			subscription.updates.map((update) => update.conversation.updatedAt),
			['2026-07-01T10:01:00Z', '2026-07-01T10:09:00Z'],
			'reads are sequenced per conversation, so the last event read is the last state applied'
		);
	} finally {
		probe.restore();
	}
});

test('events for different conversations are not collapsed into each other', async () => {
	const gates = [];
	const probe = startBinding({
		respond: (request) => new Promise((resolve) => gates.push({ request, resolve })),
	});

	try {
		subscribe(probe.binding);
		probe.sockets[0].live();

		probe.sockets[0].publish('conv-1');
		probe.sockets[0].publish('conv-2');
		await settle();

		assert.deepEqual(
			probe.requests.map((request) => request.variables.id),
			['conv-1', 'conv-2'],
			'collapsing is per conversation; two correspondents are two reads'
		);
	} finally {
		probe.restore();
	}
});

test('a failed re-read reaches the reader instead of an empty catch', async () => {
	const probe = startBinding({
		respond: () => ({ data: null, errors: [{ message: 'internal error' }] }),
	});

	try {
		subscribe(probe.binding);
		probe.sockets[0].live();
		probe.sockets[0].publish('conv-1');
		await settle();

		assert.equal(probe.rereads.at(-1), 'failed');
		// The socket is still live, and that is exactly why this has to be said:
		// a strip reading "live" over a thread that stopped growing is the one
		// shape of this failure nobody can see.
		assert.equal(isLive({ socket: 'live', catchUp: 'idle', reread: 'failed' }), false);
	} finally {
		probe.restore();
	}
});

test('a re-read refused for the session surfaces the sign-in state and stops the retry', async () => {
	const probe = startBinding({
		respond: () => ({ data: null, errors: [{ message: 'invalid or expired token' }] }),
	});

	try {
		const subscription = subscribe(probe.binding);
		probe.sockets[0].live();
		probe.sockets[0].publish('conv-1');
		await settle();

		assert.equal(probe.rereads.at(-1), 'auth-required');
		assert.match(subscription.statuses.at(-1).reason ?? '', /sign in again/i);

		// And the context's own reconnect finds a closed door: a token lesser has
		// already rejected is not offered again every twenty seconds.
		subscription.stop();
		const retry = subscribe(probe.binding);
		assert.equal(probe.sockets.length, 1, 'no socket may be opened for a rejected session');
		assert.equal(retry.statuses.at(-1).status, 'error');
		assert.match(retry.statuses.at(-1).reason ?? '', /sign in again/i);
	} finally {
		probe.restore();
	}
});

test('a socket refused for the session is not retried either', async () => {
	const probe = startBinding();

	try {
		const subscription = subscribe(probe.binding);
		probe.sockets[0].open();
		probe.sockets[0].deliver({
			type: 'connection_error',
			payload: { message: 'unauthorized', code: 'unauthorized' },
		});
		await settle();

		assert.equal(probe.realtimeStates.at(-1), 'requires-auth');
		subscription.stop();

		subscribe(probe.binding);
		assert.equal(probe.sockets.length, 1, 'the refused credential must not open a second socket');
	} finally {
		probe.restore();
	}
});

/* ============================================================
   What the reader is told
   ============================================================ */

test('the only state that renders no notice is a live socket with no gap behind it', () => {
	assert.equal(realtimeNotice({ socket: 'live', catchUp: 'idle', reread: 'idle' }), null);

	for (const input of [
		{ socket: 'live', catchUp: 'catching-up', reread: 'idle' },
		{ socket: 'live', catchUp: 'failed', reread: 'idle' },
		{ socket: 'live', catchUp: 'idle', reread: 'failed' },
		{ socket: 'live', catchUp: 'idle', reread: 'auth-required' },
		{ socket: 'connecting', catchUp: 'idle', reread: 'idle' },
		{ socket: 'degraded', catchUp: 'idle', reread: 'idle' },
		{ socket: 'unavailable', catchUp: 'idle', reread: 'idle' },
		{ socket: 'unsupported', catchUp: 'idle', reread: 'idle' },
		{ socket: 'requires-auth', catchUp: 'idle', reread: 'idle' },
		{ socket: 'idle', catchUp: 'idle', reread: 'idle' },
	]) {
		const notice = realtimeNotice(input);
		assert.ok(notice, `${JSON.stringify(input)} rendered nothing`);
		assert.ok(notice.text.length > 0);
		assert.equal(isLive(input), false, `${JSON.stringify(input)} must not read as live`);
	}
});

test('the expired session is the only notice that offers the sign-in control', () => {
	const expired = realtimeNotice({ socket: 'live', catchUp: 'idle', reread: 'auth-required' });
	assert.equal(expired.signIn, true);
	assert.equal(expired.tone, 'alert');

	assert.equal(
		realtimeNotice({ socket: 'unavailable', catchUp: 'idle', reread: 'idle' }).signIn,
		false,
		'a dropped socket is not a session problem, and must not offer a sign-in that will not fix it'
	);
});

test('an expired session outranks a catch-up, because only one of them needs the reader', () => {
	const notice = realtimeNotice({
		socket: 'live',
		catchUp: 'catching-up',
		reread: 'auth-required',
	});
	assert.match(notice.text, /sign in again/i);
});
