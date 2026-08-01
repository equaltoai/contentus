/**
 * The selection races, and the guards that close them.
 *
 * THE TWO DEFECTS. Every read on this surface is asynchronous and the selection
 * is not, and the vendored state machine keys nothing by conversation:
 *
 *   1. **The composer is not bound to a conversation.** `Messages.Composer`
 *      holds its draft in component state and reads `selectedConversation` at
 *      SEND time. On a wide viewport, where selecting is in-place, text typed
 *      for one person and left unsent is still in the box when the next
 *      conversation opens — and the next Send delivers it to them.
 *   2. **The thread is one unkeyed array — and the summary is not keyed
 *      either.** `selectConversation` writes whichever `onFetchMessages`
 *      resolves last into `state.messages`, `sendMessage` appends its confirmed
 *      message to whatever is selected when the mutation returns, and the same
 *      completion stamps that message onto the selected conversation's LIST
 *      CARD (`lastMessage`/`updatedAt`). A slow read for A renders under B's
 *      name, and a send dispatched to A resolves onto B's card — outside the
 *      reach of any message filter. The deep link is the same shape in the
 *      other direction: `/messages/{id}` resolves asynchronously and would act
 *      on its late answer over a conversation the reader chose while it loaded
 *      — selecting over their choice when it succeeds, and hiding their choice
 *      behind a not-found or failed surface when it does not.
 *
 * Neither is fixable in the vendored source, which contentus does not edit. So
 * the surface reconciles both, and this file drives the reconciliation.
 *
 * WHAT IS EVIDENCE HERE AND WHAT IS WIRING. The first group drives the REAL
 * guards in `$lib/messaging/selection` with the message shapes
 * `$lib/messaging/contract` actually produces — out-of-order completions
 * included. The second parses `MessagingSurface.svelte` with the REAL Svelte
 * compiler and asserts the structure that applies them: a `{#key}` around the
 * composer keyed on the selected conversation, and the guards actually called.
 * That second group is a structural claim, labelled as one; the repo has no DOM
 * harness, and a probe that re-implemented the component would agree with itself
 * whatever the component said.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'svelte/compiler';

import { toConversation, toDirectMessage, toMessagePage } from '../src/lib/messaging/contract.ts';
import {
	deepLinkVerdict,
	isForeignMessage,
	mergeForConversation,
	retainOwnSummaries,
	retainOwnSummary,
	retainSelectedMessages,
	trackSelectionRevisions,
} from '../src/lib/messaging/selection.ts';
// Namespace import for the OPTIONAL probes: a bite must reach the verdict — and
// record the old code's real answer — on a ref where the gate it exercises does
// not exist yet, so the gate is called through the namespace, optional-chained.
import * as selection from '../src/lib/messaging/selection.ts';

const actor = {
	id: '/users/ada',
	username: 'ada',
	domain: null,
	displayName: 'Ada Lovelace',
	avatar: null,
};

/** A message as `contract.toDirectMessage` produces one — stamped conversation included. */
function message(id, conversationId, createdAt = '2026-07-01T10:00:00Z') {
	return toDirectMessage(
		{
			id,
			content: `<p>${id}</p>`,
			createdAt,
			sensitive: false,
			spoilerText: null,
			actor,
			attachments: [],
		},
		conversationId
	);
}

/** A page as `contract.toMessagePage` produces one. */
function page(conversationId, ids) {
	return toMessagePage(
		{
			edges: ids.map((id, index) => ({
				cursor: `cursor-${index}`,
				node: {
					id,
					content: `<p>${id}</p>`,
					createdAt: `2026-07-01T10:0${index}:00Z`,
					sensitive: false,
					spoilerText: null,
					actor,
					attachments: [],
				},
			})),
			pageInfo: { hasNextPage: false, endCursor: 'cursor-last' },
		},
		conversationId
	);
}

/** A conversation as `contract.toConversation` produces one — stamped summary included. */
function conversation(id, lastMessageId, updatedAt = '2026-07-01T09:00:00Z') {
	return toConversation({
		id,
		unread: false,
		createdAt: '2026-07-01T08:00:00Z',
		updatedAt,
		accounts: [actor],
		lastStatus: lastMessageId
			? {
					id: lastMessageId,
					content: `<p>${lastMessageId}</p>`,
					createdAt: updatedAt,
					sensitive: false,
					spoilerText: null,
					actor,
					attachments: [],
				}
			: null,
		viewerMetadata: {
			requestState: 'ACCEPTED',
			requestedAt: null,
			acceptedAt: null,
			declinedAt: null,
		},
	});
}

/**
 * The vendored `sendMessage` completion, reproduced exactly: the confirmed
 * message is stamped onto whichever conversation is selected WHEN THE MUTATION
 * RETURNS, and the list is re-sorted on that time. `selectedId` is B's when the
 * reader moved on mid-flight — which is the whole defect.
 */
function vendoredSendCompletion(conversations, selectedId, confirmed) {
	const updated = conversations.map((c) =>
		c.id === selectedId ? { ...c, lastMessage: confirmed, updatedAt: confirmed.createdAt } : c
	);
	return [...updated].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/* ============================================================
   The thread renders only what belongs to it
   ============================================================ */

test('a message stamped with another conversation is foreign, and one with none is not', () => {
	assert.equal(isForeignMessage(message('m1', 'conv-a'), 'conv-b'), true);
	assert.equal(isForeignMessage(message('m1', 'conv-a'), 'conv-a'), false);

	// A shape this module does not understand is kept rather than dropped:
	// silently removing a message it cannot classify would be the more dangerous
	// of the two mistakes — a thread quietly missing a reply.
	assert.equal(
		isForeignMessage({ ...message('m1', 'conv-a'), conversationId: '' }, 'conv-b'),
		false
	);
});

test('a late read for a deselected conversation does not render', () => {
	// The race, in the order it actually happens: the reader opens A, opens B
	// while A is still loading, and A's answer lands last. The vendored context
	// writes it into the one `messages` array it has; this is what stops it
	// reaching the screen under B's name.
	const selected = 'conv-b';
	const late = [message('a1', 'conv-a'), message('a2', 'conv-a')];

	assert.deepEqual(retainSelectedMessages(late, selected), []);
});

test('a send confirmed after the reader moved on lands in no thread', () => {
	// `sendMessage` appends the confirmed message to `state.messages` with no
	// check that the conversation it was sent to is still the one on screen.
	const thread = [message('b1', 'conv-b')];
	const afterConfirm = [...thread, message('a-sent', 'conv-a')];

	assert.deepEqual(
		retainSelectedMessages(afterConfirm, 'conv-b').map((m) => m.id),
		['b1'],
		"a message sent to another conversation must not appear in this one's thread"
	);
});

test('nothing is selected, so nothing belongs', () => {
	assert.deepEqual(retainSelectedMessages([message('a1', 'conv-a')], null), []);
});

test('an untouched thread keeps its identity, so the reconciler settles', () => {
	// Load-bearing: the surface writes back only when this returns a DIFFERENT
	// array. Returning a fresh copy every time would make the effect that calls
	// it loop forever.
	const thread = [message('a1', 'conv-a'), message('a2', 'conv-a')];
	assert.equal(retainSelectedMessages(thread, 'conv-a'), thread);
});

/* ============================================================
   Pages merge into the conversation they were requested for
   ============================================================ */

test('a page that resolves after the selection moved is dropped, not merged', () => {
	const thread = [message('b1', 'conv-b')];
	const older = page('conv-a', ['a1', 'a2']);

	assert.equal(
		mergeForConversation(thread, older.messages, 'conv-a', 'conv-b'),
		null,
		'"load older" for a conversation the reader has left must not merge into the open one'
	);
});

test('a page that resolves while its conversation is still open merges', () => {
	const thread = [message('a3', 'conv-a', '2026-07-01T10:03:00Z')];
	const older = page('conv-a', ['a1', 'a2']);

	const merged = mergeForConversation(thread, older.messages, 'conv-a', 'conv-a');
	assert.deepEqual(
		merged.map((m) => m.id),
		['a1', 'a2', 'a3'],
		'the older page sorts in ahead of what was already on screen'
	);
});

test('a page whose edges name another conversation cannot smuggle a message in', () => {
	// Defence in depth against the selection check alone: the guard is the
	// stamp on each message, not only the id the caller asked for.
	const stray = [message('a1', 'conv-a'), message('x1', 'conv-x')];

	assert.deepEqual(
		mergeForConversation([], stray, 'conv-a', 'conv-a').map((m) => m.id),
		['a1']
	);
});

test('merging also drops whatever foreign message was already in the array', () => {
	const contaminated = [message('a1', 'conv-a'), message('b1', 'conv-b')];

	assert.deepEqual(
		mergeForConversation(contaminated, page('conv-a', ['a2']).messages, 'conv-a', 'conv-a').map(
			(m) => m.id
		),
		['a1', 'a2']
	);
});

test('out-of-order completions leave the open thread correct whichever lands last', () => {
	// Both reads in flight, resolving in the wrong order, against the same array
	// the components render.
	const readA = page('conv-a', ['a1', 'a2']);
	const readB = page('conv-b', ['b1']);
	const selected = 'conv-b';

	let thread = [];
	// B's read lands first…
	thread = mergeForConversation(thread, readB.messages, 'conv-b', selected) ?? thread;
	// …then A's, for the conversation nobody is looking at any more.
	thread = mergeForConversation(thread, readA.messages, 'conv-a', selected) ?? thread;

	assert.deepEqual(
		thread.map((m) => m.id),
		['b1'],
		'the thread on screen must contain only the conversation on screen'
	);
});

/* ============================================================
   Summaries stay with the conversation they belong to
   ============================================================ */

test('a send confirmed after the reader moved on is re-filed under the conversation it was sent to', () => {
	// The race, exactly as the vendored context writes it: composed in A, sent
	// to A, resolved after the reader opened B — and B's card takes A's words,
	// A's time, and the top of the list.
	const own = new Map();
	const list = [
		conversation('conv-a', 'a-last', '2026-07-01T09:00:00Z'),
		conversation('conv-b', 'b-last', '2026-07-01T09:30:00Z'),
	];
	// The reconciling effect records what each card legitimately carries BEFORE
	// the completion lands; drive that pass first, as the surface does.
	retainOwnSummaries(list, own);

	const confirmed = message('a-sent', 'conv-a', '2026-07-01T10:00:00Z');
	const misfiled = vendoredSendCompletion(list, 'conv-b', confirmed);
	assert.equal(misfiled[0].id, 'conv-b', 'the vendored write puts B on top, on A’s time');
	assert.equal(misfiled[0].lastMessage.id, 'a-sent', '…showing A’s message');

	const repaired = retainOwnSummaries(misfiled, own);
	const a = repaired.find((c) => c.id === 'conv-a');
	const b = repaired.find((c) => c.id === 'conv-b');

	assert.equal(b.lastMessage.id, 'b-last', "B's card shows B's own last message again");
	assert.equal(
		b.updatedAt,
		'2026-07-01T09:30:00Z',
		'and is not sorted by an event that did not happen to it'
	);
	assert.equal(a.lastMessage.id, 'a-sent', "the send did happen — to A, and A's card says so");
	assert.equal(a.updatedAt, '2026-07-01T10:00:00Z');
	assert.equal(repaired[0].id, 'conv-a', 'the order follows the corrected times');
});

test('the same misfiling on the selected conversation is restored too', () => {
	// `sendMessage` writes the summary twice: onto the list row AND onto
	// `selectedConversation`, which every later `{ ...selected }` spread carries
	// forward. Both copies are repaired.
	const own = new Map();
	const list = [conversation('conv-b', 'b-last')];
	retainOwnSummaries(list, own);

	const confirmed = message('a-sent', 'conv-a', '2026-07-01T10:00:00Z');
	const misfiledSelected = { ...list[0], lastMessage: confirmed, updatedAt: confirmed.createdAt };

	const restored = retainOwnSummary(misfiledSelected, own);
	assert.equal(restored.lastMessage.id, 'b-last');
	assert.equal(restored.updatedAt, '2026-07-01T09:00:00Z');

	// And a clean object keeps its identity, so the effect settles.
	assert.equal(retainOwnSummary(list[0], own), list[0]);
});

test('a clean list keeps its identity, so the reconciler settles', () => {
	// Load-bearing in the same way as the thread guard: the surface writes back
	// only when this returns a DIFFERENT array.
	const own = new Map();
	const list = [conversation('conv-a', 'a-last'), conversation('conv-b', 'b-last')];
	assert.equal(retainOwnSummaries(list, own), list);
	// …and identity is stable across passes, once the map has recorded them.
	assert.equal(retainOwnSummaries(list, own), list);
});

test('two summaries misfiled onto one conversation re-home only the newer', () => {
	const own = new Map();
	const list = [conversation('conv-a', 'a-last'), conversation('conv-b', 'b-last')];
	retainOwnSummaries(list, own);

	// Both cards somehow carry a message naming conv-a; the older one is not
	// resurrected onto A's card over the newer.
	const older = message('a-older', 'conv-a', '2026-07-01T10:00:00Z');
	const newer = message('a-newer', 'conv-a', '2026-07-01T11:00:00Z');
	const misfiled = [
		{ ...list[0], lastMessage: older, updatedAt: older.createdAt },
		{ ...list[1], lastMessage: newer, updatedAt: newer.createdAt },
	];

	const repaired = retainOwnSummaries(misfiled, own);
	assert.equal(repaired.find((c) => c.id === 'conv-a').lastMessage.id, 'a-newer');
});

/* ============================================================
   A deep link does not outrank the reader's own choice
   ============================================================ */

test('a late deep-link completion selects only while the revision its dispatch captured still holds', () => {
	// Dispatched with nothing selected — the normal cold link — a found
	// conversation is selected while nothing has changed the selection.
	const quiet = trackSelectionRevisions(null);
	const quietDispatch = quiet.capture();
	assert.equal(deepLinkVerdict(quiet, quietDispatch, null, 'found'), 'select');

	// The reader picked B from the list while the by-id read was in flight:
	// they have chosen, and the link's answer must not move them.
	const chosen = trackSelectionRevisions(null);
	const chosenDispatch = chosen.capture();
	chosen.observe('conv-b');
	assert.equal(deepLinkVerdict(chosen, chosenDispatch, 'conv-b', 'found'), 'stale');
});

test('a missing answer after the reader chose does not take the screen over', () => {
	// Cold-link C is loading; the reader chooses B from the list; C then
	// resolves MISSING. The resolution states take precedence over the selected
	// thread in the render branches, so a not-found written now would hide B.
	const revisions = trackSelectionRevisions(null);
	const atDispatch = revisions.capture();
	revisions.observe('conv-b');

	assert.equal(
		deepLinkVerdict(revisions, atDispatch, 'conv-b', 'missing'),
		'stale',
		'a null completion after the reader chose must not become the not-found surface'
	);
});

test('a failed answer after the reader chose does not take the screen over', () => {
	// Same race, rejection instead of null: the failed surface is also a state
	// that hides the thread the reader chose.
	const revisions = trackSelectionRevisions(null);
	const atDispatch = revisions.capture();
	revisions.observe('conv-b');

	assert.equal(
		deepLinkVerdict(revisions, atDispatch, 'conv-b', 'failed'),
		'stale',
		'a rejection after the reader chose must not become the failed surface'
	);
});

test('choosing away and back is still choosing: id-equality is not the guard', () => {
	// THE ABA CASE. Dispatched with C selected; the reader opens B and then
	// returns to C. The id at completion IS the id at dispatch, and the
	// equality guard this replaced read that as "nothing happened". The
	// revision counts the changes, and two happened — so the completion is
	// stale against a state the reader no longer holds.
	const revisions = trackSelectionRevisions('conv-c');
	const atDispatch = revisions.capture();
	revisions.observe('conv-b');
	revisions.observe('conv-c');

	assert.equal(
		deepLinkVerdict(revisions, atDispatch, 'conv-c', 'found'),
		'stale',
		'a completion landing on the id the reader returned to must still be stale'
	);
});

test('the verdict reads the selection as it is NOW, not as the last flush left it', () => {
	// The reader's click writes the selection synchronously; the effect that
	// observes it into the tracker runs on the next flush, and a completion can
	// land between the two. The verdict observes the selection it is handed
	// before it judges, so the gap re-admits nothing.
	const revisions = trackSelectionRevisions(null);
	const atDispatch = revisions.capture();
	// Deliberately NO observe() call here — the click's effect has not flushed.
	assert.equal(
		deepLinkVerdict(revisions, atDispatch, 'conv-b', 'found'),
		'stale',
		'a completion landing before the observer flushes must still lose to the choice'
	);
});

test('with no intervening choice, a missing answer is not-found and a failed one is failed', () => {
	// The genuine states still render when the reader has NOT chosen: the link
	// is the only thing on screen, and its answer is what the pane must say.
	for (const [outcome, expected] of [
		['missing', 'not-found'],
		['failed', 'failed'],
	]) {
		const revisions = trackSelectionRevisions(null);
		const atDispatch = revisions.capture();
		assert.equal(deepLinkVerdict(revisions, atDispatch, null, outcome), expected);
	}
});

test('a folder switch while the link loads is a reader act, even when the selection never changed', () => {
	// THE NULL→NULL PATH. A cold deep link for C on a wide two-pane viewport:
	// the selection is already null while the by-id read is pending, and the
	// reader switches Inbox→Requests. The vendored `fetchConversations` clears
	// the selection to the null it already holds, so the observer is presented
	// the SAME null and there is no id transition to count — an intent
	// transition-counting cannot see. The folder handler stamps it explicitly,
	// and every completion family then loses to the choice: the found one that
	// would open C over the reader's folder, and the missing/failed ones that
	// would take the thread pane over on the same path.
	for (const outcome of ['found', 'missing', 'failed']) {
		const revisions = trackSelectionRevisions(null);
		const atDispatch = revisions.capture();
		// The vendored clear, presented to the observer as the same null: by
		// itself this counts nothing, which is exactly the gap.
		revisions.observe(null);
		// The explicit stamp from the folder tab handler. Optional on purpose:
		// against a ref whose tracker had no stamp this probe still reaches the
		// verdict, and the verdict is the old guard's real answer — the
		// completion acts over the reader's folder choice, which is the defect.
		revisions.act?.();
		assert.equal(
			deepLinkVerdict(revisions, atDispatch, null, outcome),
			'stale',
			`a ${outcome} completion after the reader switched folder must not act over the choice`
		);
	}
});

test('opening New Message while the link loads is a reader act, even though the selection never moves', () => {
	// THE UNSTAMPED COMPETITOR. A cold deep link for C on a wide two-pane
	// viewport: the vendored `NewConversation` trigger is usable while the
	// by-id read is pending, and everything the reader does next — open the
	// modal, search, pick a recipient — leaves `selectedConversation` at the
	// null it already holds. The component exposes no callback until AFTER it
	// has created and internally selected a conversation, so none of it
	// reaches the observer, and an unstamped open leaves the pending link
	// admissible: the late missing/failed answer writes a resolution the
	// render branches never reset, and the thread the reader goes on to create
	// stays hidden behind the link they had already abandoned — while a late
	// found answer selects C behind the modal. The open is stamped at the
	// surface's own wrapper, and every completion family then loses to it.
	for (const outcome of ['found', 'missing', 'failed']) {
		const revisions = trackSelectionRevisions(null);
		const atDispatch = revisions.capture();
		// Searching and picking a recipient, presented to the observer as the
		// same null: by themselves they count nothing, which is exactly the gap.
		revisions.observe(null);
		// The trigger click with the modal not yet open, judged by the surface's
		// owned gate. Optional on purpose: against a ref with no gate this probe
		// still reaches the verdict, and the verdict is the old code's real
		// answer — the completion acts over the reader's New Message intent,
		// which is the defect.
		const wrapper = { querySelector: () => null };
		const triggerClick = {
			closest: (selector) => (selector === '.new-conversation__trigger' ? {} : null),
		};
		if (selection.isNewConversationOpenIntent?.(wrapper, triggerClick)) revisions.act();
		assert.equal(
			deepLinkVerdict(revisions, atDispatch, null, outcome),
			'stale',
			`a ${outcome} completion after the reader opened New Message must not act over the choice`
		);
	}
});

test('a canceled or no-change New Message modal does not stale the link — only the open stamps', () => {
	// The no-op discipline, same as the current-folder re-click: an act that
	// chooses nothing must not take the pending link away from its answer. A
	// click INSIDE the modal — the search field, a result, the cancel button —
	// is a continuation of the act the open already stamped (or, here, no act
	// at all), and re-pressing the trigger while the modal is already open
	// changes nothing. Neither stamps, so the link stays admissible and its
	// missing answer still earns the not-found surface.
	const modalOpen = {
		querySelector: (selector) => (selector === '.new-conversation__modal' ? {} : null),
	};
	const modalClick = { closest: () => null };
	const triggerClick = {
		closest: (selector) => (selector === '.new-conversation__trigger' ? {} : null),
	};

	for (const [click, label] of [
		[modalClick, 'a click inside the modal'],
		[triggerClick, 'a trigger re-press while the modal is open'],
	]) {
		// Strict equality, not truthiness: the gate must exist and answer false —
		// an absent gate is the defect the previous test pins, not a pass here.
		assert.equal(
			selection.isNewConversationOpenIntent?.(modalOpen, click),
			false,
			`${label} must not be judged an open intent`
		);

		const revisions = trackSelectionRevisions(null);
		const atDispatch = revisions.capture();
		if (selection.isNewConversationOpenIntent?.(modalOpen, click)) revisions.act();
		assert.equal(
			deepLinkVerdict(revisions, atDispatch, null, 'missing'),
			'not-found',
			`${label} chooses nothing, so the link's own answer must still stand`
		);
	}
});

/* ============================================================
   The structure that applies them
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

const surfaceSource = readFileSync('src/lib/messaging/MessagingSurface.svelte', 'utf8');
const surface = parse(surfaceSource, { modern: true });

function calls(ast, name) {
	for (const node of walk(ast)) {
		if (node.type !== 'CallExpression') continue;
		const callee = node.callee;
		if (callee?.type === 'Identifier' && callee.name === name) return true;
		if (callee?.type === 'MemberExpression' && callee.property?.name === name) return true;
	}
	return false;
}

/** How many call sites of `name` appear in a Svelte/ESTree tree. */
function countCalls(ast, name) {
	let count = 0;
	for (const node of walk(ast)) {
		if (node.type !== 'CallExpression') continue;
		const callee = node.callee;
		if (callee?.type === 'Identifier' && callee.name === name) count += 1;
		if (callee?.type === 'MemberExpression' && callee.property?.name === name) count += 1;
	}
	return count;
}

test('the composer is keyed by conversation, so a draft cannot outlive its recipient', () => {
	// STRUCTURAL. The claim is that the composer instance — and therefore the
	// `content` it holds — is destroyed with the conversation it was opened for,
	// which is the only binding available while `Composer` exposes no prop that
	// names one.
	const keyBlocks = [...walk(surface.fragment)].filter((node) => node.type === 'KeyBlock');
	assert.ok(keyBlocks.length > 0, 'no {#key} block in the surface');

	const composerKeys = keyBlocks.filter((block) =>
		[...walk(block.fragment)].some((node) => node.type === 'Component' && node.name === 'Composer')
	);
	assert.equal(composerKeys.length, 1, 'the composer must sit inside exactly one {#key} block');

	// And it is keyed on the SELECTED CONVERSATION, not on something that
	// happens to change occasionally.
	const expression = surfaceSource.slice(
		composerKeys[0].expression.start,
		composerKeys[0].expression.end
	);
	assert.match(
		expression,
		/selected\??\.id/,
		`the composer key must be the selected conversation id; it is \`${expression}\``
	);
});

test('the surface reconciles the thread through the real guards', () => {
	assert.ok(
		calls(surface.instance, 'retainSelectedMessages'),
		'the thread must be filtered to the selected conversation'
	);
	assert.ok(
		calls(surface.instance, 'mergeForConversation'),
		'every page merge must be keyed to the conversation it was requested for'
	);
});

test('the surface reconciles summaries and the deep link through the real guards', () => {
	// STRUCTURAL, same caveat as above. The send completion writes the summary
	// onto the list AND the selected copy, and the deep link resolves
	// asynchronously; all three guards must actually be called.
	assert.ok(
		calls(surface.instance, 'retainOwnSummaries'),
		'list cards must be restored to the conversation their summary names'
	);
	assert.ok(
		calls(surface.instance, 'retainOwnSummary'),
		'the selected conversation copy must be restored too'
	);
	assert.ok(
		calls(surface.instance, 'trackSelectionRevisions'),
		'the selection must be counted as a revision, so a choice away and back still counts'
	);
	// EVERY completion — the known one, the found-or-missing one, and the
	// failed one — is judged against the revision captured at dispatch. Fewer
	// than three call sites means some completion family acts unchecked, which
	// is the hole that let a late not-found or failed surface hide the thread
	// the reader chose.
	assert.ok(
		countCalls(surface.instance, 'deepLinkVerdict') >= 3,
		'every deep-link completion — success, null, AND error — must be judged against the dispatch revision'
	);
});

test('the surface stamps the reader intents a selected-id transition cannot show', () => {
	// STRUCTURAL, same caveat as above. A folder switch on a cold deep link
	// clears an already-null selection back to null, so no transition exists
	// for the observer to count: the intent must be stamped explicitly at the
	// handlers the reader's action passes through — the folder tabs, and the
	// list's own select. Counted over the WHOLE tree, not only the script: the
	// folder tab handler is inline in the markup.
	assert.ok(
		countCalls(surface, 'act') >= 2,
		'the folder tab handler AND the list select must stamp the reader act explicitly — the selection cannot always show it'
	);
});

test('the New Message open is stamped through the owned gate, not by editing the vendored trigger', () => {
	// STRUCTURAL, same caveat as above. The vendored `NewConversation` owns its
	// trigger and exposes no open callback, so the open intent — a reader act
	// the selection never shows — is judged and stamped at the surface's own
	// wrapper, in owned source. Counted over the WHOLE tree: the delegation
	// handler is inline in the markup.
	assert.ok(
		calls(surface, 'isNewConversationOpenIntent'),
		'the New Conversation wrapper must judge the click through the owned gate in $lib/messaging/selection'
	);
	assert.ok(
		countCalls(surface, 'act') >= 3,
		'folder switch, list select, AND the New Message open must stamp the reader act explicitly'
	);
});

test('the vendored NewConversation still has no open-intent hook', () => {
	// INVERTED, like the composer pin: it describes the upstream gap that makes
	// the delegated wrapper necessary, and fails the day upstream ships an open
	// hook — at which point the wrapper can stamp through the component's own
	// callback instead of delegating the click.
	const component = readFileSync('src/lib/components/messaging/NewConversation.svelte', 'utf8');
	const props = component.match(/interface Props \{([\s\S]*?)\n\t\}/);
	assert.ok(props, 'could not read the Props interface');

	const names = [...props[1].matchAll(/^\s*(\w+)[?:]/gm)].map((match) => match[1]);
	assert.deepEqual(
		names.sort(),
		['class', 'initialParticipants', 'onConversationCreated'],
		'the NewConversation Props surface changed — check whether an open-intent hook appeared'
	);
});

test('the surface never routes a request through the context methods that ignore the answer', () => {
	// STRUCTURAL, and the bite for the accept/decline finding.
	// `context.acceptMessageRequest` removes the card and switches folder
	// whatever request state comes back, and `context.declineMessageRequest`
	// reports nothing about whether the decline was confirmed. Calling either
	// from here is what made the UI contradict the server, so the surface must
	// not — it posts the same mutations through the binding's handlers and
	// renders the answer.
	for (const name of ['acceptMessageRequest', 'declineMessageRequest']) {
		assert.equal(
			calls(surface.instance, name),
			false,
			`MessagingSurface calls context.${name}, which does not read the returned request state`
		);
	}

	assert.ok(
		calls(surface.instance, 'acceptResolution') && calls(surface.instance, 'declineResolution'),
		'the surface must resolve both actions from what lesser returned'
	);
});

test('the vendored composer still has no conversation of its own', () => {
	// INVERTED, like the renderer-authority pins: it describes the upstream gap
	// that makes the key necessary, and fails the day upstream closes it — at
	// which point the key can go and per-conversation drafts become possible.
	const composer = readFileSync('src/lib/components/messaging/Composer.svelte', 'utf8');
	const props = composer.match(/interface Props \{([\s\S]*?)\n\t\}/);
	assert.ok(props, 'could not read the Props interface');

	const names = [...props[1].matchAll(/^\s*(\w+)[?:]/gm)].map((match) => match[1]);
	assert.deepEqual(
		names.sort(),
		['class'],
		'the composer Props surface changed — check whether a conversation or draft prop appeared'
	);

	assert.match(
		composer,
		/let content = \$state\(''\)/,
		'the draft is no longer a bare component-local string — re-check the keying'
	);
});
