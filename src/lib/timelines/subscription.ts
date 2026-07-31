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

/** Why a live connection is not running. Each is a different thing to tell a reader. */
export type SubscriptionState =
	'idle' | 'connecting' | 'live' | 'unsupported' | 'requires-auth' | 'unavailable';

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
	} = options;

	const open = socketFactory ?? ((url, protocols) => new WebSocket(url, protocols));

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

	onState('connecting');

	const send = (message: unknown) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};

	socket.onopen = () => {
		// Auth goes in the payload, never the query string — lesser ignores
		// query-string tokens for GraphQL subscriptions, and a token in a URL
		// lands in logs and proxy history besides.
		send({
			type: 'connection_init',
			payload: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
		});
	};

	socket.onmessage = (event) => {
		let message: { type?: string; id?: string; payload?: unknown };
		try {
			message = JSON.parse(String(event.data));
		} catch {
			// A frame this client cannot parse is not a reason to tear down a
			// working stream; the protocol tolerates unknown messages.
			return;
		}

		switch (message.type) {
			case 'connection_ack':
				send({ type: 'subscribe', id, payload: { query, variables } });
				onState('live');
				return;

			case 'ping':
				send({ type: 'pong', payload: message.payload });
				return;

			case 'next': {
				if (message.id !== id) return;
				const payload = message.payload as { data?: T; errors?: unknown[] } | undefined;
				// A `next` carrying only errors is a field failure, not a post.
				// Passing it on would prepend an empty card.
				if (payload?.data) onData(payload.data);
				return;
			}

			case 'error': {
				if (message.id !== id) return;
				// lesser's subscription resolver returns "authentication required
				// for this timeline type" for every type but PUBLIC without a
				// token. That is a state with an action attached, so it is
				// reported as itself rather than as a generic failure.
				const text = JSON.stringify(message.payload ?? '').toLowerCase();
				onState(text.includes('authentication required') ? 'requires-auth' : 'unavailable');
				closed = true;
				socket.close();
				return;
			}

			case 'complete':
				if (message.id !== id) return;
				closed = true;
				onState('idle');
				socket.close();
				return;
		}
	};

	socket.onerror = () => {
		if (!closed) onState('unavailable');
	};

	socket.onclose = () => {
		if (closed) return;
		closed = true;
		// Both cases are `unavailable` to a reader — a stream that never
		// established and one that dropped are the same absence of live posts,
		// and the affordance offered for either is the same reconnect.
		onState('unavailable');
	};

	return () => {
		if (closed) return;
		closed = true;
		send({ type: 'complete', id });
		try {
			socket.close();
		} catch {
			// Already closing; nothing to do.
		}
		onState('idle');
	};
}
