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
 *   2. **The thread is one unkeyed array.** `selectConversation` writes
 *      whichever `onFetchMessages` resolves last into `state.messages`, and
 *      `sendMessage` appends its confirmed message to whatever is selected when
 *      the mutation returns. A slow read for A renders under B's name.
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

import { toDirectMessage, toMessagePage } from '../src/lib/messaging/contract.ts';
import {
	isForeignMessage,
	mergeForConversation,
	retainSelectedMessages,
} from '../src/lib/messaging/selection.ts';

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
