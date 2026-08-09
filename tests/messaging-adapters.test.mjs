/**
 * Face 5's adapters, driven against a stubbed `fetch`.
 *
 * These load the REAL shipped modules — `$lib/messaging/adapter`,
 * `$lib/messaging/handlers`, `$lib/messaging/contract` — and stub only the
 * network, the same split `tests/timeline-adapters.test.mjs` uses. A probe that
 * reproduced the adapter's logic in test code would agree with itself no matter
 * what the shipped file said; that lesson cost a round in M4 and is not paid
 * twice.
 *
 * The claims here are mostly about what the adapters REFUSE to do, because the
 * defects this face inherits are all of that shape: an empty list standing in
 * for a failed read, a send reported as delivered because the promise resolved,
 * a decline recorded because the mutation did not throw.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMessagingAdapter } from '../src/lib/messaging/adapter.ts';
import { createMessagingBinding, classifyMessagingError } from '../src/lib/messaging/handlers.ts';
import {
	mergeMessages,
	toConversation,
	toMessagePage,
	unreadConversationCount,
} from '../src/lib/messaging/contract.ts';
import {
	acceptResolution,
	applyConversation,
	countPendingRequests,
	declineResolution,
	isResolved,
	requestNotice,
	withoutConversation,
} from '../src/lib/messaging/requests.ts';

/** A lesser actor, as `ActorSummary` returns one. */
function actor(username, domain = null) {
	return {
		id: domain ? `https://${domain}/users/${username}` : `/users/${username}`,
		username,
		domain,
		displayName: username === 'ada' ? 'Ada Lovelace' : username,
		avatar: null,
	};
}

/** A lesser object, as the DM surface returns one. */
function object(id, content, who = 'ada', createdAt = '2026-07-01T10:00:00Z') {
	return {
		id,
		content,
		createdAt,
		sensitive: false,
		spoilerText: null,
		actor: actor(who),
		attachments: [],
	};
}

function conversation(
	id,
	{ requestState = 'ACCEPTED', unread = false, unreadCount = 0, last = null } = {}
) {
	return {
		id,
		unread,
		unreadCount,
		createdAt: '2026-07-01T09:00:00Z',
		updatedAt: '2026-07-01T10:00:00Z',
		accounts: [actor('ada'), actor('bob')],
		lastStatus: last,
		viewerMetadata: {
			requestState,
			requestedAt: requestState === 'PENDING' ? '2026-07-01T09:00:00Z' : null,
			acceptedAt: requestState === 'ACCEPTED' ? '2026-07-01T09:30:00Z' : null,
			declinedAt: null,
		},
	};
}

/** A folder page, in the `conversationConnection` shape lesser serves at v1.6.4. */
function conversationConnection(conversations) {
	return {
		conversationConnection: {
			edges: conversations.map((c) => ({ cursor: `${c.id}-cursor`, node: c })),
			pageInfo: { hasNextPage: false, endCursor: null },
		},
	};
}

/**
 * Run `body` with `fetch` stubbed, returning what it produced and every request
 * it made. `respond({ operation, variables })` returns the GraphQL envelope.
 *
 * The operation name is read from the document contentus actually sent, so a
 * probe asserting on it is asserting on the wire rather than on its own
 * expectations.
 */
async function withStubbedFetch(respond, body) {
	const requests = [];
	const original = globalThis.fetch;

	globalThis.fetch = async (input, init = {}) => {
		const payload = init.body ? JSON.parse(init.body) : {};
		const operation =
			/(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(payload.query ?? '')?.[1] ?? '';
		const request = {
			url: typeof input === 'string' ? input : String(input),
			operation,
			query: payload.query ?? '',
			variables: payload.variables ?? {},
			authorization: new Headers(init.headers).get('authorization'),
		};
		requests.push(request);

		const envelope = respond(request) ?? { data: null };
		return new Response(JSON.stringify(envelope), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};

	try {
		return { value: await body(), requests };
	} finally {
		globalThis.fetch = original;
	}
}

const adapterFor = (overrides = {}) =>
	createMessagingAdapter({ accessToken: () => 'token-abc', ...overrides });

/* ============================================================
   The false-empty refusal — the defect this boundary exists for
   ============================================================ */

test('a failed conversation read throws rather than returning an empty list', async () => {
	const adapter = adapterFor();

	await withStubbedFetch(
		() => ({ data: null, errors: [{ message: 'internal error' }] }),
		async () => {
			await assert.rejects(
				() => adapter.fetchConversations('INBOX', 50),
				/could not complete the conversation list/i,
				'a failed read must not resolve — greater returns [] here, which renders "No messages yet"'
			);
		}
	);
});

test('a conversation read whose list is absent throws, even with no errors', async () => {
	const adapter = adapterFor();

	// The exact shape greater's `Array.isArray(c) ? c : []` swallows: data came
	// back, the field did not. An absent list is not an empty one.
	await withStubbedFetch(
		() => ({ data: {} }),
		async () => {
			await assert.rejects(
				() => adapter.fetchConversations('INBOX', 50),
				/did not return a conversation list/i
			);
		}
	);
});

test('an empty list that lesser genuinely returned is passed through', async () => {
	const adapter = adapterFor();

	// The other half, and the reason the check is on presence rather than
	// length: a real empty inbox must still render as empty.
	const { value } = await withStubbedFetch(
		() => ({ data: conversationConnection([]) }),
		() => adapter.fetchConversations('INBOX', 50)
	);
	assert.deepEqual(value, []);
});

test('a search whose account list is absent throws rather than reporting no matches', async () => {
	const adapter = adapterFor();

	await withStubbedFetch(
		() => ({ data: { search: {} } }),
		async () => {
			await assert.rejects(
				() => adapter.searchActors('ada', 10),
				/did not return search results/i,
				'the picker would say "no users found" for a search that never ran'
			);
		}
	);
});

/* ============================================================
   Credential refusals keep their own identity
   ============================================================ */

test('an auth refusal is classified as auth-required, not as unavailable', async () => {
	const adapter = adapterFor();

	for (const message of [
		'authentication required',
		'unauthorized',
		'invalid or expired token',
		'not authenticated',
	]) {
		await withStubbedFetch(
			() => ({ data: null, errors: [{ message }] }),
			async () => {
				const error = await adapter.fetchConversations('INBOX', 50).catch((e) => e);
				assert.equal(
					classifyMessagingError(error),
					'auth-required',
					`"${message}" must offer the reader a sign-in, not a wait`
				);
			}
		);
	}
});

test('an auth refusal wins even when lesser also returned data', async () => {
	const adapter = adapterFor();

	// A partially-authorized response is still a session the reader has to renew.
	await withStubbedFetch(
		() => ({
			data: conversationConnection([conversation('c1')]),
			errors: [{ message: 'unauthorized' }],
		}),
		async () => {
			const error = await adapter.fetchConversations('INBOX', 50).catch((e) => e);
			assert.equal(classifyMessagingError(error), 'auth-required');
		}
	);
});

test('the message the context kept still classifies, after the class is gone', () => {
	// The context stores `error.message` as a string, so by the time a component
	// reads it the class has been discarded. This is what keeps the sign-in
	// affordance attached to the one failure it fixes.
	assert.equal(
		classifyMessagingError('Your session has expired. Sign in again to read your messages.'),
		'auth-required'
	);
	assert.equal(classifyMessagingError('This instance did not answer.'), 'unavailable');
	assert.equal(classifyMessagingError('something else entirely'), 'unknown');
});

/* ============================================================
   Partial reads are marked, never silently presented as whole
   ============================================================ */

test('data alongside errors is returned AND marked partial', async () => {
	const seen = [];
	const adapter = adapterFor({ onPartial: (operation) => seen.push(operation) });

	const { value } = await withStubbedFetch(
		() => ({
			data: conversationConnection([conversation('c1')]),
			errors: [{ message: 'lastStatus resolver failed' }],
		}),
		() => adapter.fetchConversations('INBOX', 50)
	);

	// Both halves matter: the conversation is worth showing, and the surface has
	// to be told something under it is missing.
	assert.equal(value.length, 1, 'the objects lesser did return should still render');
	assert.deepEqual(seen, ['the conversation list'], 'the partial marker did not travel');
});

test('a clean read is not marked partial', async () => {
	const seen = [];
	const adapter = adapterFor({ onPartial: (operation) => seen.push(operation) });

	await withStubbedFetch(
		() => ({ data: conversationConnection([conversation('c1')]) }),
		() => adapter.fetchConversations('INBOX', 50)
	);
	assert.deepEqual(seen, [], 'a clean read must not raise the partial notice');
});

/* ============================================================
   Mutations report what lesser confirmed, not what was attempted
   ============================================================ */

test('a send whose message did not come back is not reported as sent', async () => {
	const adapter = adapterFor();

	// The composer clears its box on a resolved promise. A reader whose message
	// vanished from the input and never reached the thread has been told it was
	// delivered by the UI moving on.
	await withStubbedFetch(
		() => ({ data: { sendMessage: { conversation: conversation('c1'), message: null } } }),
		async () => {
			await assert.rejects(
				() => adapter.sendMessage('c1', 'hello'),
				/did not confirm the message was sent/i
			);
		}
	);
});

test('only an explicit true is a decline', async () => {
	const adapter = adapterFor();

	for (const [returned, expected] of [
		[true, true],
		[false, false],
		[null, false],
		[undefined, false],
	]) {
		const { value } = await withStubbedFetch(
			() => ({ data: { declineMessageRequest: returned } }),
			() => adapter.declineMessageRequest('c1')
		);
		assert.equal(
			value,
			expected,
			`declineMessageRequest returning ${JSON.stringify(returned)} should be ${expected} — anything else removes a request lesser may still hold`
		);
	}
});

test('accept refuses to resolve without the conversation carrying its new state', async () => {
	const adapter = adapterFor();

	await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: null } }),
		async () => {
			await assert.rejects(
				() => adapter.acceptMessageRequest('c1'),
				/did not confirm the request was accepted/i,
				'without the returned state the surface would have to assume the accept worked'
			);
		}
	);
});

test('a plain message sends no mediaIds rather than an empty list', async () => {
	const adapter = adapterFor();

	const { requests } = await withStubbedFetch(
		() => ({ data: { sendMessage: { message: object('m1', 'hi'), conversation: null } } }),
		() => adapter.sendMessage('c1', 'hi')
	);

	assert.equal(
		requests[0].variables.mediaIds,
		null,
		'`[]` and "no attachments" are not the same claim'
	);
});

/* ============================================================
   Auth placement
   ============================================================ */

test('every conversation read carries the bearer token, read at call time', async () => {
	let token = 'first-token';
	const adapter = adapterFor({ accessToken: () => token });

	const { requests } = await withStubbedFetch(
		() => ({ data: conversationConnection([]) }),
		async () => {
			await adapter.fetchConversations('INBOX', 50);
			// The session can be replaced between two calls; an adapter holding the
			// token it was built with would keep posting the stale one.
			token = 'second-token';
			await adapter.fetchConversations('REQUESTS', 50);
		}
	);

	assert.equal(requests[0].authorization, 'Bearer first-token');
	assert.equal(requests[1].authorization, 'Bearer second-token');
});

test('an anonymous adapter sends no Authorization header at all', async () => {
	const adapter = adapterFor({ accessToken: () => null });

	const { requests } = await withStubbedFetch(
		() => ({ data: conversationConnection([]) }),
		() => adapter.fetchConversations('INBOX', 50)
	);

	assert.equal(requests[0].authorization ?? null, null);
});

/* ============================================================
   The projections
   ============================================================ */

test('a local actor is named by username and a remote one by actor id', () => {
	// What lesser's conversation MUTATIONS match on. Getting this wrong opens a
	// conversation with the wrong person, or with nobody.
	const local = toConversation(conversation('c1')).participants[0];
	assert.equal(local.id, 'ada', 'a local actor should be keyed by bare username');
	assert.equal(
		local.actorId,
		'/users/ada',
		'the original id must survive for own-message matching'
	);
	assert.equal(local.handle, 'ada');

	const remote = toConversation({
		...conversation('c2'),
		accounts: [actor('cleo', 'other.example')],
	}).participants[0];
	assert.equal(remote.id, 'https://other.example/users/cleo');
	assert.equal(remote.handle, 'cleo@other.example');
});

test('folder is derived from viewerMetadata.requestState and nothing else', () => {
	assert.equal(toConversation(conversation('c1', { requestState: 'PENDING' })).folder, 'REQUESTS');
	assert.equal(toConversation(conversation('c2', { requestState: 'ACCEPTED' })).folder, 'INBOX');
	// A declined conversation is not a pending request. It is not in Requests.
	assert.equal(toConversation(conversation('c3', { requestState: 'DECLINED' })).folder, 'INBOX');
});

test('unreadCount is lesser’s real per-conversation count, and the badge still counts conversations', () => {
	const conversations = [
		toConversation(conversation('c1', { unread: true, unreadCount: 3 })),
		toConversation(conversation('c2', { unread: true, unreadCount: 1 })),
		toConversation(conversation('c3')),
	];

	// lesser serves the real message count at v1.6.4, and it flows through
	// unflattened — greater's own handler still collapses `unread` to 1/0.
	assert.deepEqual(
		conversations.map((c) => c.unreadCount),
		[3, 1, 0]
	);
	// The badge still counts CONVERSATIONS with unread activity, by design, and
	// its label says so: three unread messages in one conversation and one in
	// another is "2 conversations", not "4 messages".
	assert.equal(unreadConversationCount(conversations), 2);
});

test('a message page is ordered by createdAt whatever order lesser returned', () => {
	// The schema does not state the edge order, and the components render the
	// array as-is with new messages appended — so a descending page would put a
	// reply above the message it answers.
	const page = toMessagePage(
		{
			edges: [
				{ cursor: 'c3', node: object('m3', 'third', 'ada', '2026-07-01T12:00:00Z') },
				{ cursor: 'c1', node: object('m1', 'first', 'ada', '2026-07-01T10:00:00Z') },
				{ cursor: 'c2', node: object('m2', 'second', 'bob', '2026-07-01T11:00:00Z') },
			],
			pageInfo: { hasNextPage: true, endCursor: 'c2' },
			totalCount: 9,
		},
		'c1'
	);

	assert.deepEqual(
		page.messages.map((m) => m.id),
		['m1', 'm2', 'm3']
	);
	assert.equal(page.endCursor, 'c2');
	assert.equal(page.hasNextPage, true);
	assert.equal(page.totalCount, 9);
});

test('merging an older page keeps one copy of a message realtime already delivered', () => {
	// Pagination and realtime write to the same list, so the page can contain a
	// message that already arrived over the socket.
	const live = [
		{ id: 'm2', conversationId: 'c1', createdAt: '2026-07-01T11:00:00Z', content: 'second' },
	];
	const older = [
		{ id: 'm1', conversationId: 'c1', createdAt: '2026-07-01T10:00:00Z', content: 'first' },
		{ id: 'm2', conversationId: 'c1', createdAt: '2026-07-01T11:00:00Z', content: 'second' },
	];

	const merged = mergeMessages(live, older);
	assert.deepEqual(
		merged.map((m) => m.id),
		['m1', 'm2'],
		'the duplicate should collapse, in order'
	);
});

test('a message body is passed through untouched', () => {
	// Renderer authority: lesser's sanitized HTML reaches the component exactly
	// as lesser wrote it. Nothing here renders, escapes, truncates or rewrites.
	const html = '<p>Hello <strong>world</strong></p>';
	const page = toMessagePage({ edges: [{ cursor: 'a', node: object('m1', html) }] }, 'c1');
	assert.equal(page.messages[0].content, html);
});

/* ============================================================
   The binding the components consume
   ============================================================ */

test('the handler object implements every operation the components call', () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	// The interface is upstream's (`MessagesHandlers`), so this is a check that
	// contentus filled it in — a missing handler degrades silently to a control
	// that does nothing when pressed.
	for (const name of [
		'onFetchConversations',
		'onFetchMessages',
		'onSendMessage',
		'onCreateConversation',
		'onAcceptMessageRequest',
		'onDeclineMessageRequest',
		'onDeleteConversation',
		'onDeleteMessage',
		'onMarkRead',
		'onSearchParticipants',
		'onSubscribeToConversationUpdates',
	]) {
		assert.equal(typeof handlers[name], 'function', `${name} is not wired`);
	}
});

test('the folder a conversation is listed under is the folder that was asked for', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value, requests } = await withStubbedFetch(
		() => ({ data: conversationConnection([conversation('c1', { requestState: 'PENDING' })]) }),
		() => handlers.onFetchConversations('REQUESTS')
	);

	assert.equal(requests[0].variables.folder, 'REQUESTS');
	assert.equal(value[0].folder, 'REQUESTS');
	assert.equal(value[0].requestState, 'PENDING', 'request state comes from viewerMetadata only');
});

test('accepting reads the returned request state rather than assuming it moved', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	// lesser saying "still pending" must leave the card in Requests. Assuming the
	// accept worked is the inference #33 rules out.
	const { value } = await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: conversation('c1', { requestState: 'PENDING' }) } }),
		() => handlers.onAcceptMessageRequest('c1')
	);
	assert.equal(value.folder, 'REQUESTS');

	const { value: accepted } = await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: conversation('c1', { requestState: 'ACCEPTED' }) } }),
		() => handlers.onAcceptMessageRequest('c1')
	);
	assert.equal(accepted.folder, 'INBOX', 'an accepted request belongs in the inbox');
});

test('a group conversation is refused before the wire, not truncated', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	// lesser's `createConversation` takes ONE participantId. Sending the first
	// and dropping the rest would hand the reader a group they thought they made.
	const { requests } = await withStubbedFetch(
		() => ({ data: { createConversation: conversation('c1') } }),
		async () => {
			await assert.rejects(() => handlers.onCreateConversation(['ada', 'bob']), /one-to-one/i);
		}
	);
	assert.equal(requests.length, 0, 'nothing should have been sent');
});

test('loadMessagePage carries the cursor lesser returned', async () => {
	const binding = createMessagingBinding({ accessToken: () => 'token' });

	const { value, requests } = await withStubbedFetch(
		() => ({
			data: {
				conversationMessages: {
					edges: [{ cursor: 'x1', node: object('m1', 'hi') }],
					pageInfo: { hasNextPage: true, endCursor: 'x1' },
					totalCount: 2,
				},
			},
		}),
		() => binding.loadMessagePage('c1', 'previous-cursor')
	);

	// The whole reason this exists: greater's `onFetchMessages` accepts a cursor
	// and returns no way to obtain one, so pagination is unreachable through it.
	assert.equal(requests[0].variables.after, 'previous-cursor');
	assert.equal(value.endCursor, 'x1');
	assert.equal(value.hasNextPage, true);
});

test('a conversation lesser does not know is not-found, not a failure', async () => {
	const binding = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({ data: { conversation: null } }),
		() => binding.loadConversation('nope')
	);

	// A clean null with no errors is the PRE-v1.6.4 answer for a missing id;
	// v1.6.4 answers with the ErrAccessDenied envelope covered below. Both mean
	// the instance answered and does not have it — a different screen from "the
	// instance did not answer", which throws.
	assert.equal(value, null);
});

/* ============================================================
   A conversation this reader cannot open — one answer, not two
   ============================================================ */

test('a foreign conversation and a nonexistent one are indistinguishable to the caller', async () => {
	// At lesser v1.6.4 (commit 21b82399a) the two are the same envelope on the
	// wire too: an ErrAccessDenied error with `data.conversation` null. Before
	// that, lesser answered a missing id with a clean `{ conversation: null }`
	// and an id belonging to other people with null PLUS a participant error —
	// no body leaked, but the difference was an existence oracle: anybody who
	// can type a URL could read "this conversation exists" off the partial-read
	// notice, one guessed id at a time. The suppression under test is what
	// keeps the two indistinguishable on PRE-v1.6.4 instances, and it stays as
	// defense-in-depth now that lesser agrees. Both must present identically.
	const missingPartials = [];
	const missing = createMessagingBinding({
		accessToken: () => 'token',
		onPartial: (operation) => missingPartials.push(operation),
	});
	const foreignPartials = [];
	const foreign = createMessagingBinding({
		accessToken: () => 'token',
		onPartial: (operation) => foreignPartials.push(operation),
	});

	// The v1.6.4 envelope, identical for "never existed" and "not yours".
	const accessDenied = () => ({
		data: { conversation: null },
		errors: [{ message: 'access denied' }],
	});
	const { value: missingValue, requests: missingRequests } = await withStubbedFetch(
		accessDenied,
		() => missing.loadConversation('never-existed')
	);
	const { value: foreignValue, requests: foreignRequests } = await withStubbedFetch(
		accessDenied,
		() => foreign.loadConversation('somebody-elses')
	);

	// Same value…
	assert.equal(missingValue, null);
	assert.equal(foreignValue, null);
	// …same disclosure…
	assert.deepEqual(foreignPartials, [], 'a null conversation must never raise the partial notice');
	assert.deepEqual(missingPartials, []);
	assert.deepEqual(foreignPartials, missingPartials);
	// …and the same amount of work, so the two do not separate on timing either.
	assert.equal(foreignRequests.length, 1);
	assert.equal(missingRequests.length, foreignRequests.length);
	assert.deepEqual(
		foreignRequests.map((request) => request.operation),
		missingRequests.map((request) => request.operation)
	);
});

test('a partial answer that DID carry the conversation is still disclosed', async () => {
	// The suppression is scoped to the null answer, and only to it. A partial read
	// the reader can see says nothing they do not already have, and dropping the
	// marker there would hide a real gap in what was rendered.
	const seen = [];
	const binding = createMessagingBinding({
		accessToken: () => 'token',
		onPartial: (operation) => seen.push(operation),
	});

	const { value } = await withStubbedFetch(
		() => ({
			data: { conversation: conversation('c1') },
			errors: [{ message: 'lastStatus failed', path: ['conversation', 'lastStatus'] }],
		}),
		() => binding.loadConversation('c1')
	);

	assert.equal(value?.id, 'c1');
	assert.deepEqual(seen, ['this conversation']);
});

/* ============================================================
   Accept and decline: the card renders what lesser returned
   ============================================================ */

test('an accept that came back PENDING resolves as unchanged, and says so', async () => {
	// The contradiction M5's review found: the vendored context removes the
	// request card and switches to Inbox whatever request state comes back, so a
	// request lesser still holds disappears from the tab that holds it. The
	// surface resolves through these instead.
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: conversation('c1', { requestState: 'PENDING' }) } }),
		() => handlers.onAcceptMessageRequest('c1')
	);

	const resolution = acceptResolution(value);
	assert.deepEqual(resolution, { kind: 'unchanged', state: 'PENDING' });
	assert.equal(isResolved(resolution), false, 'nothing may be removed for a request still pending');
	assert.match(requestNotice(resolution, 'Ada').text, /still reports it as pending/);
	assert.equal(requestNotice(resolution, 'Ada').tone, 'alert');

	// And the row keeps the state lesser returned, so the card still behaves like
	// the pending request it is.
	const list = applyConversation([{ id: 'c1', requestState: 'PENDING' }], value);
	assert.equal(list[0].requestState, 'PENDING');
	assert.equal(list[0].folder, 'REQUESTS');
	assert.equal(countPendingRequests(list), 1);
});

test('an accept that came back ACCEPTED is the only one that reads as accepted', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: conversation('c1', { requestState: 'ACCEPTED' }) } }),
		() => handlers.onAcceptMessageRequest('c1')
	);

	const resolution = acceptResolution(value);
	assert.deepEqual(resolution, { kind: 'accepted' });
	assert.equal(isResolved(resolution), true);
	assert.match(requestNotice(resolution, 'Ada').text, /accepted/);
	assert.equal(countPendingRequests(applyConversation([{ id: 'c1' }], value)), 0);
});

test('a DECLINED answer to an accept is reported as what it is', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: conversation('c1', { requestState: 'DECLINED' }) } }),
		() => handlers.onAcceptMessageRequest('c1')
	);

	assert.deepEqual(acceptResolution(value), { kind: 'unchanged', state: 'DECLINED' });
	assert.match(
		requestNotice(acceptResolution(value), 'Ada').text,
		/declined, so it was not accepted/
	);
});

test('a decline lesser did not confirm removes nothing and announces nothing', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({ data: { declineMessageRequest: false } }),
		() => handlers.onDeclineMessageRequest('c1')
	);

	const resolution = declineResolution(value);
	assert.deepEqual(resolution, { kind: 'not-declined' });
	assert.equal(isResolved(resolution), false);
	assert.match(requestNotice(resolution, 'Ada').text, /did not confirm the decline/);
	assert.equal(requestNotice(resolution, 'Ada').tone, 'alert');

	// The list is untouched: the card stays where lesser still has it.
	assert.deepEqual(withoutConversation([{ id: 'c1' }], 'other').length, 1);
});

test('a confirmed decline is the only one that removes the card', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({ data: { declineMessageRequest: true } }),
		() => handlers.onDeclineMessageRequest('c1')
	);

	assert.deepEqual(declineResolution(value), { kind: 'declined' });
	assert.deepEqual(withoutConversation([{ id: 'c1' }, { id: 'c2' }], 'c1'), [{ id: 'c2' }]);
	assert.match(requestNotice({ kind: 'declined' }, 'Ada').text, /declined/);
});

test('a request mutation that failed leaves the request where it was', async () => {
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	await withStubbedFetch(
		() => ({ data: { acceptMessageRequest: null } }),
		async () => {
			await assert.rejects(() => handlers.onAcceptMessageRequest('c1'), /did not confirm/);
		}
	);

	// Which is what the surface renders from: an accept that threw is not an
	// accept, and the notice says the request is unchanged rather than naming an
	// outcome nobody reported.
	for (const failure of ['auth-required', 'unavailable', 'unknown']) {
		const notice = requestNotice({ kind: 'failed', failure }, 'Ada');
		assert.match(notice.text, /unchanged/);
		assert.equal(notice.tone, 'alert');
	}
	assert.match(
		requestNotice({ kind: 'failed', failure: 'auth-required' }, 'Ada').text,
		/session expired/
	);
});

test('the Requests badge counts what lesser listed as pending', async () => {
	// Not the ids the vendored tracker has ever seen pending: it only forgets an
	// id when a later read carries the same conversation as non-pending, and a
	// request resolved here never appears in a folder read again.
	const { handlers } = createMessagingBinding({ accessToken: () => 'token' });

	const { value } = await withStubbedFetch(
		() => ({
			data: conversationConnection([
				conversation('c1', { requestState: 'PENDING' }),
				conversation('c2', { requestState: 'PENDING' }),
				conversation('c3', { requestState: 'ACCEPTED' }),
			]),
		}),
		() => handlers.onFetchConversations('REQUESTS')
	);

	assert.equal(countPendingRequests(value), 2);
	assert.equal(countPendingRequests(withoutConversation(value, 'c1')), 1);
});
