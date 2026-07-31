/**
 * lesser's GraphQL subscription transport, as lesser documents it.
 *
 * `docs/api-reference.md` → "GraphQL subscriptions (WebSocket)" states the whole
 * contract and this module implements exactly it, nothing more:
 *
 *   - endpoint `wss://ws.<stage-domain>`, the ROOT of the WebSocket domain
 *   - the `graphql-transport-ws` subprotocol
 *   - auth in the `connection_init` payload; "query string tokens are ignored
 *     for GraphQL subscriptions"
 *
 * WHY THIS IS NOT A NEW TRANSPORT. `graphql-transport-ws` is a published wire
 * protocol, and the six frames below are its whole surface for one subscription.
 * lesser's own example uses the `graphql-ws` npm package, and declaring that
 * package was the first thing tried — it hoists a second copy of `ws` and moves
 * the SEC-2 advisory path pinned in
 * `gov-infra/planning/contentus-disclosed-upstream-findings.json`, which is a
 * real cost paid for a client contentus needs a few hundred bytes of. So this
 * speaks the documented framing over the browser's native WebSocket, the same
 * call `cms/graphql.ts` already makes against Apollo for queries and for the
 * same stated reason. The endpoint, the subprotocol and the auth placement are
 * all lesser's; only the socket is ours.
 *
 * WHY THE VENDORED `src/lib/transport.ts` IS NOT USED. It speaks Mastodon's
 * streaming protocol — `/api/v1/streaming` with `{type:'subscribe', stream}`
 * frames. That is a real lesser surface (`wss://ws.<domain>/stream`) and a
 * DIFFERENT one from GraphQL subscriptions; face 4 is specified against
 * `subscription timelineUpdates`, so using it would be answering a different
 * contract than the one the milestone names.
 *
 * THE ONE PLACE THIS INFERS RATHER THAN READS — and it is routed upstream.
 * There is no contract-served value for the subscription endpoint.
 * `InstanceInfo.streamingUrl` looks like the field for it and is not: lesser
 * resolves it to `r.Config.BaseURL()`, the instance's HTTP origin, where
 * Mastodon's `urls.streaming_api` is the WebSocket URL. So the host below is
 * derived by prefixing `ws.` onto the origin the page was served from, which is
 * what lesser's own documentation describes and what its CDK builds — but it is
 * this client reading a topology convention, not a value the instance stated.
 * Filed as an ask on lesser to publish the endpoint; see
 * docs/consumption/timeline-contract.md. Until then the derivation is confined
 * to `subscriptionEndpoint` so there is one place to delete.
 *
 * NO INSTANCE DOMAIN IS HARD-CODED anywhere here: the host comes from the
 * request that was actually served, so expanding past the dev instance stays a
 * configuration event.
 *
 * THE GATEWAY AND THE RESOLVER DISAGREE, AND THE GATEWAY WINS. lesser's
 * subscription RESOLVER admits an anonymous PUBLIC subscriber; its WebSocket
 * GATEWAY never lets one reach the resolver. `handleConnectionInit`
 * (`cmd/graphql-ws/main.go`) requires an access token in the `connection_init`
 * payload and answers an empty one with a `connection_error` — before any
 * GraphQL dispatch — and `handleSubscribe` refuses again for a connection with
 * no username. So anonymous realtime is unreachable at runtime no matter what
 * the resolver would allow, and this module reports what the runtime does. Two
 * consequences live here: `connection_error` is a handled frame, and
 * `realtimeAvailability` in `contract.ts` gates realtime on a token for every
 * type. Filed against lesser; see docs/consumption/timeline-contract.md.
 */

/** The subprotocol lesser's `cmd/graphql-ws` negotiates. */
export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

/**
 * The subscription endpoint for a page served from `origin`, or null.
 *
 * Returns null rather than guessing when the origin is unusable, and the null
 * is load-bearing: every caller degrades to "live updates unavailable", which
 * is honest, where a fabricated URL would produce a socket that fails in a way
 * the reader cannot act on.
 *
 * `http:` origins map to `ws:` so a local or non-TLS instance is reachable;
 * everything else is `wss:`.
 */
export function subscriptionEndpoint(origin: string | null | undefined): string | null {
	if (!origin) return null;

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return null;
	}

	if (!url.hostname) return null;
	// Already a ws host — do not stack another prefix onto it.
	const host = url.hostname.startsWith('ws.') ? url.hostname : `ws.${url.hostname}`;
	const scheme = url.protocol === 'http:' ? 'ws:' : 'wss:';
	const port = url.port ? `:${url.port}` : '';

	return `${scheme}//${host}${port}`;
}

/**
 * Why a live connection is not running. Each is a different thing to tell a
 * reader, and each has to be REACHED — a state the transport can never enter is
 * a screen nobody sees.
 *
 * `degraded` is the one that is not a failure and not health: the socket is
 * open and delivering, and something it delivered could not be turned into a
 * post. Reporting that as `live` would be the transport asserting a
 * completeness it lost; reporting it as `unavailable` would be telling a reader
 * the stream stopped when it did not. It is sticky for the life of the socket,
 * because the gap it names does not close on its own — only a re-read does that.
 */
export type SubscriptionState =
	'idle' | 'connecting' | 'live' | 'degraded' | 'unsupported' | 'requires-auth' | 'unavailable';

/**
 * Close codes from the `graphql-transport-ws` spec, used where it names them.
 *
 * A client that meets a frame it cannot parse is required to terminate rather
 * than skip it: the peers have disagreed about the protocol, and a session that
 * carries on after that is one whose subsequent frames mean nothing definite.
 */
export const CLOSE_INVALID_FRAME = 4400;
export const CLOSE_ACK_TIMEOUT = 4408;

/** How long to wait for `connection_ack` before giving up on the handshake. */
export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

export interface SubscriptionHandlers<T> {
	/** One payload from lesser. Called for every `next` frame. */
	onData: (data: T) => void;
	onState: (state: SubscriptionState) => void;
}

export interface SubscriptionOptions<T> extends SubscriptionHandlers<T> {
	endpoint: string;
	query: string;
	variables?: Record<string, unknown>;
	accessToken?: string | null;
	/** Injectable for probes; defaults to the platform WebSocket. */
	socketFactory?: (url: string, protocols: string | string[]) => WebSocket;
	/** Handshake deadline. Zero disables it. */
	ackTimeoutMs?: number;
	/**
	 * Injectable timer, returning its own canceller.
	 *
	 * Present so the ack deadline is DRIVEN by a probe rather than waited out:
	 * a timeout asserted by sleeping is a timeout asserted flakily.
	 */
	scheduleTimeout?: (run: () => void, ms: number) => () => void;
}

/**
 * Whether a refusal from lesser is one the reader can act on by signing in.
 *
 * lesser refuses on two surfaces with two vocabularies, and both land here. The
 * gateway's `connection_error` carries `{message, code}` with `code:
 * "unauthorized"` for a missing, invalid or expired token; the resolver's
 * `error` carries a plain gqlerror whose message is "authentication required for
 * this timeline type". Neither is a generic failure: both have the same action
 * attached, and collapsing them into "something went wrong" hides it.
 */
function isAuthRefusal(payload: unknown): boolean {
	const text = JSON.stringify(payload ?? '').toLowerCase();
	return (
		text.includes('authentication required') ||
		text.includes('unauthorized') ||
		text.includes('unauthenticated') ||
		text.includes('access token required') ||
		text.includes('invalid or expired token')
	);
}

/**
 * Open one subscription and return a function that closes it.
 *
 * DELIBERATELY DOES NOT RECONNECT. A dropped socket becomes `unavailable` and
 * stays there until the reader acts. Silent reconnection would leave a gap in
 * the stream that nothing marks — the items published while the socket was down
 * never arrive, and the timeline would look continuous while missing posts.
 * Face 4's affordance is a visible "reconnect" the reader chooses, which also
 * refetches the page, so the gap is closed rather than hidden.
 *
 * EVERY WAY THIS CAN END, ENDS IN A STATE. That is the property to preserve
 * when editing this function, and the one it did not previously have: a refusal
 * with no case, a frame that would not parse, or a handshake that was never
 * answered all left the caller on `connecting` — a spinner with nothing behind
 * it, which is the one outcome a reader can neither read nor act on. There is
 * no path below that returns without either reporting a state or having already
 * reported one.
 */
export function subscribe<T>(options: SubscriptionOptions<T>): () => void {
	const {
		endpoint,
		query,
		variables = {},
		accessToken = null,
		onData,
		onState,
		socketFactory,
		ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
		scheduleTimeout,
	} = options;

	const open = socketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
	const schedule =
		scheduleTimeout ??
		((run: () => void, ms: number) => {
			const handle = setTimeout(run, ms);
			return () => clearTimeout(handle);
		});

	let socket: WebSocket;
	try {
		socket = open(endpoint, GRAPHQL_TRANSPORT_WS);
	} catch {
		onState('unavailable');
		return () => {};
	}

	// One subscription per socket, so a fixed id is unambiguous.
	const id = '1';
	let closed = false;
	let acked = false;
	let cancelAckTimeout: (() => void) | null = null;

	onState('connecting');

	const send = (message: unknown) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};

	/** Report a terminal state once and close the socket, optionally with a code. */
	const finish = (state: SubscriptionState, code?: number, reason?: string) => {
		if (closed) return;
		closed = true;
		cancelAckTimeout?.();
		cancelAckTimeout = null;
		onState(state);
		try {
			if (code === undefined) socket.close();
			else socket.close(code, reason);
		} catch {
			// Already closing; the state is what mattered.
		}
	};

	socket.onopen = () => {
		// Auth goes in the payload, never the query string — lesser ignores
		// query-string tokens for GraphQL subscriptions, and a token in a URL
		// lands in logs and proxy history besides.
		send({
			type: 'connection_init',
			payload: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
		});

		// The handshake gets a deadline, because a server that never answers it
		// is indistinguishable from one still thinking, and the difference to a
		// reader is a spinner that resolves and one that does not.
		if (ackTimeoutMs > 0) {
			cancelAckTimeout = schedule(() => {
				if (acked || closed) return;
				finish('unavailable', CLOSE_ACK_TIMEOUT, 'Connection acknowledgement timeout');
			}, ackTimeoutMs);
		}
	};

	socket.onmessage = (event) => {
		if (closed) return;

		let message: { type?: string; id?: string; payload?: unknown };
		try {
			const parsed: unknown = JSON.parse(String(event.data));
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new SyntaxError('frame is not an object');
			}
			message = parsed as { type?: string; id?: string; payload?: unknown };
		} catch {
			// The spec is explicit that an unparseable frame terminates the socket
			// with 4400 rather than being skipped: the peers have disagreed about
			// the protocol, and every frame after that means nothing definite. The
			// previous behaviour — ignore and carry on — kept a session alive that
			// this client could no longer reason about, and reported it as `live`.
			finish('unavailable', CLOSE_INVALID_FRAME, 'Invalid message received');
			return;
		}

		switch (message.type) {
			case 'connection_ack':
				acked = true;
				cancelAckTimeout?.();
				cancelAckTimeout = null;
				send({ type: 'subscribe', id, payload: { query, variables } });
				onState('live');
				return;

			case 'connection_error':
				// NOT a `graphql-transport-ws` frame — it belongs to the older
				// `subscriptions-transport-ws` protocol — but it is what lesser's
				// gateway actually sends, and it sends it for EVERY init payload
				// with no token (`cmd/graphql-ws/main.go` → `handleConnectionInit`).
				// It also does not close the socket afterwards, so a client with no
				// case for it waits on an ack that will never come. Recorded as a
				// contract/runtime contradiction in
				// docs/consumption/timeline-contract.md; handled here because a
				// reader's spinner is not the place to litigate it.
				finish(isAuthRefusal(message.payload) ? 'requires-auth' : 'unavailable');
				return;

			case 'ping':
				send({ type: 'pong', payload: message.payload });
				return;

			case 'pong':
				// This client sends no `ping`, so an unprompted `pong` is a
				// keepalive to be ignored rather than a frame to fail on.
				return;

			case 'next': {
				if (message.id !== id) return;
				const payload = message.payload as { data?: T; errors?: unknown[] } | undefined;
				if (payload?.data) {
					onData(payload.data);
					return;
				}
				// A `next` with no data is a field failure, not a post — passing it
				// on would prepend an empty card. The stream is still open, so this
				// is not a teardown; but something lesser published did not arrive,
				// and leaving the strip reading `live` would be the client claiming
				// a continuity it just lost.
				onState('degraded');
				return;
			}

			case 'error': {
				if (message.id !== id) return;
				// The resolver's refusal, as opposed to the gateway's above.
				finish(isAuthRefusal(message.payload) ? 'requires-auth' : 'unavailable');
				return;
			}

			case 'complete':
				if (message.id !== id) return;
				// lesser ending the operation is not this client ending it. The
				// socket stops delivering posts either way, and `idle` — the state
				// the teardown path uses — renders no copy at all, so a
				// server-initiated end used to leave a live strip that silently
				// said nothing. It is the same absence as a drop, with the same
				// refresh attached.
				finish('unavailable');
				return;
		}
	};

	socket.onerror = () => {
		if (!closed) onState('unavailable');
	};

	socket.onclose = () => {
		if (closed) return;
		closed = true;
		cancelAckTimeout?.();
		cancelAckTimeout = null;
		// Both cases are `unavailable` to a reader — a stream that never
		// established and one that dropped are the same absence of live posts,
		// and the affordance offered for either is the same reconnect.
		onState('unavailable');
	};

	return () => {
		if (closed) return;
		closed = true;
		cancelAckTimeout?.();
		cancelAckTimeout = null;
		send({ type: 'complete', id });
		try {
			socket.close();
		} catch {
			// Already closing; nothing to do.
		}
		onState('idle');
	};
}
