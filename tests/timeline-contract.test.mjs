/**
 * Face 4's contract probes.
 *
 * These load `src/lib/timelines/contract.ts` STRAIGHT OFF DISK under
 * `node --test --experimental-strip-types` — no bundler, no alias resolver — so
 * what is asserted here is the module that ships, not a re-statement of it.
 *
 * Every assertion below is written to be capable of failing: each one names a
 * specific value lesser sends and a specific value the UI must show, and each
 * would go red if the projection stopped doing its job. The M2d lesson that a
 * test which cannot fail is worse than no test, because it is counted, is the
 * reason the fixtures are full objects rather than the two fields under test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ACTOR_QUERY,
	TIMELINE_QUERY,
	TIMELINE_UPDATES_SUBSCRIPTION,
	actorHandle,
	classifyTimelineFailure,
	readRequiresAuth,
	realtimeAvailability,
	toAccount,
	toTimelinePage,
	toTimelineStatus,
} from '../src/lib/timelines/contract.ts';

/** A complete lesser `Object` as the timeline resolver returns one. */
function lesserObject(overrides = {}) {
	return {
		id: 'obj-1',
		type: 'NOTE',
		content: '<p>Server-sanitized <em>HTML</em></p>',
		contentHash: 'sha256:abc',
		visibility: 'PUBLIC',
		sensitive: false,
		spoilerText: null,
		createdAt: '2026-07-01T10:00:00Z',
		updatedAt: '2026-07-01T10:00:00Z',
		repliesCount: 3,
		likesCount: 7,
		sharesCount: 2,
		viewerFavourited: false,
		viewerBookmarked: false,
		viewerPinned: false,
		boosted: false,
		actor: {
			id: 'actor-1',
			username: 'ada',
			domain: null,
			displayName: 'Ada',
			summary: 'Writes things',
			avatar: 'https://example.test/a.png',
			header: null,
			followers: 10,
			following: 4,
			statusesCount: 20,
			bot: false,
			locked: false,
			createdAt: '2026-01-01T00:00:00Z',
			isAgent: false,
		},
		attachments: [],
		tags: [],
		mentions: [],
		inReplyTo: null,
		agentAttribution: null,
		...overrides,
	};
}

/* ---------------------------------------------------------------------------
 * Viewer state — the honest-states rule applied to a `Boolean!` field
 * ------------------------------------------------------------------------ */

test('anonymous reads carry NO viewer state, because lesser sends false for "no viewer"', () => {
	// lesser's ViewerFavourited returns false the instant there is no username
	// in context. Projecting that as `favourited: false` would assert that a
	// viewer who does not exist has not favourited the post.
	const status = toTimelineStatus(
		lesserObject({ viewerFavourited: true, viewerBookmarked: true, boosted: true }),
		{ viewerAuthenticated: false }
	);

	assert.equal(status.favourited, undefined, 'favourited must be unknown, not false');
	assert.equal(status.bookmarked, undefined, 'bookmarked must be unknown, not false');
	assert.equal(status.reblogged, undefined, 'reblogged must be unknown, not false');
	assert.ok(!('pinned' in status), 'pinned must be absent entirely');
});

test('authenticated reads carry viewer state verbatim, both true and false', () => {
	const on = toTimelineStatus(
		lesserObject({
			viewerFavourited: true,
			viewerBookmarked: true,
			viewerPinned: true,
			boosted: true,
		}),
		{ viewerAuthenticated: true }
	);
	assert.equal(on.favourited, true);
	assert.equal(on.bookmarked, true);
	assert.equal(on.pinned, true);
	assert.equal(on.reblogged, true);

	const off = toTimelineStatus(lesserObject(), { viewerAuthenticated: true });
	assert.equal(off.favourited, false, 'a signed-in reader who has not favourited is a real false');
	assert.equal(off.reblogged, false);
});

/* ---------------------------------------------------------------------------
 * Renderer authority
 * ------------------------------------------------------------------------ */

test('content is passed through byte-for-byte, never transformed', () => {
	const html = '<p>One</p><blockquote>Two</blockquote><p><code>three()</code></p>';
	const status = toTimelineStatus(lesserObject({ content: html }), { viewerAuthenticated: false });
	assert.equal(status.content, html);
});

test('no document selects a source or Markdown field', () => {
	for (const [name, document] of Object.entries({
		TIMELINE_QUERY,
		ACTOR_QUERY,
		TIMELINE_UPDATES_SUBSCRIPTION,
	})) {
		for (const forbidden of ['source', 'markdown', 'contentSource', 'rawContent', 'bodySource']) {
			assert.ok(
				!new RegExp(`\\b${forbidden}\\b`, 'i').test(document),
				`${name} must not select \`${forbidden}\``
			);
		}
	}
});

test('no document selects totalCount, which lesser computes as the page length', () => {
	// query_resolvers_notes.go returns `TotalCount: len(edges)`. A field that
	// cannot mean what its name says is safer absent than explained.
	assert.ok(!/totalCount/.test(TIMELINE_QUERY));
});

/* ---------------------------------------------------------------------------
 * Visibility — narrow on drift
 * ------------------------------------------------------------------------ */

test('lesser FOLLOWERS becomes private, and an unknown reach narrows to direct', () => {
	const each = (visibility) =>
		toTimelineStatus(lesserObject({ visibility }), { viewerAuthenticated: false }).visibility;

	assert.equal(each('PUBLIC'), 'public');
	assert.equal(each('UNLISTED'), 'unlisted');
	assert.equal(each('FOLLOWERS'), 'private', 'lesser spells followers-only FOLLOWERS');
	assert.equal(each('DIRECT'), 'direct');
	// The one that matters: a member this client predates must not be labelled
	// public, because that badge would over-promise the post's reach.
	assert.equal(each('SOME_FUTURE_REACH'), 'direct');
	assert.equal(each(null), 'direct');
});

/* ---------------------------------------------------------------------------
 * Projection detail
 * ------------------------------------------------------------------------ */

test('boostedObject becomes reblog, and the inner status keeps its own author', () => {
	const status = toTimelineStatus(
		lesserObject({
			id: 'boost-1',
			boosted: true,
			boostedObject: lesserObject({
				id: 'inner-1',
				content: '<p>Original</p>',
				actor: { ...lesserObject().actor, id: 'actor-2', username: 'grace', domain: 'remote.test' },
			}),
		}),
		{ viewerAuthenticated: true }
	);

	assert.equal(status.id, 'boost-1');
	assert.equal(status.reblog.id, 'inner-1');
	assert.equal(status.reblog.content, '<p>Original</p>');
	assert.equal(status.reblog.account.acct, 'grace@remote.test');
});

test('a remote actor gets a user@host handle and a local one does not', () => {
	assert.equal(actorHandle('ada', null), 'ada');
	assert.equal(actorHandle('ada', 'remote.test'), 'ada@remote.test');
	assert.equal(toAccount(lesserObject().actor).acct, 'ada');
});

test('engagement counts map across lesser’s names, not Mastodon’s', () => {
	// lesser calls them likesCount/sharesCount; the card calls them
	// favouritesCount/reblogsCount. Swapping the pair is invisible in the UI.
	const status = toTimelineStatus(
		lesserObject({ likesCount: 11, sharesCount: 5, repliesCount: 2 }),
		{
			viewerAuthenticated: false,
		}
	);
	assert.equal(status.favouritesCount, 11);
	assert.equal(status.reblogsCount, 5);
	assert.equal(status.repliesCount, 2);
});

test('attachments keep their alt text and preview, and an unknown kind stays visible', () => {
	const status = toTimelineStatus(
		lesserObject({
			attachments: [
				{
					id: 'm1',
					type: 'IMAGE',
					url: 'https://example.test/i.png',
					preview: 'https://example.test/p.png',
					description: 'A diagram',
					blurhash: 'LKO2',
					width: 800,
					height: 600,
				},
				{ id: 'm2', type: 'model/gltf-binary', url: 'https://example.test/x.glb' },
			],
		}),
		{ viewerAuthenticated: false }
	);

	assert.equal(status.mediaAttachments.length, 2);
	assert.equal(status.mediaAttachments[0].description, 'A diagram', 'alt text must survive');
	assert.equal(status.mediaAttachments[0].previewUrl, 'https://example.test/p.png');
	assert.deepEqual(status.mediaAttachments[0].meta, { width: 800, height: 600 });
	assert.equal(status.mediaAttachments[1].type, 'image', 'an unknown kind is shown, not dropped');
});

test('agent attribution is surfaced from lesser’s own fields and never invented', () => {
	const attributed = toTimelineStatus(
		lesserObject({
			agentAttribution: { triggerType: 'schedule', modelId: 'claude-opus-5', delegatedBy: 'ada' },
		}),
		{ viewerAuthenticated: false }
	);
	assert.equal(attributed.agentAttribution.triggerType, 'schedule');
	assert.equal(attributed.agentAttribution.modelId, 'claude-opus-5');

	const plain = toTimelineStatus(lesserObject(), { viewerAuthenticated: false });
	assert.equal(plain.agentAttribution, undefined, 'a human post gets no attribution block');
});

test('an object missing its actor is skipped rather than rendered authorless', () => {
	assert.equal(
		toTimelineStatus(lesserObject({ actor: null }), { viewerAuthenticated: false }),
		null
	);
	assert.equal(toTimelineStatus(lesserObject({ id: '' }), { viewerAuthenticated: false }), null);
	assert.equal(toTimelineStatus(null, { viewerAuthenticated: false }), null);
});

/* ---------------------------------------------------------------------------
 * Pages
 * ------------------------------------------------------------------------ */

test('a page reads hasNextPage from lesser, never from how many items arrived', () => {
	// excludeAgents drops edges AFTER the cursor is computed, so a short page
	// says nothing about whether more exist.
	const page = toTimelinePage(
		{
			edges: [{ cursor: 'c1', node: lesserObject() }],
			pageInfo: { hasNextPage: true, endCursor: 'c1' },
		},
		{ viewerAuthenticated: false }
	);

	assert.equal(page.items.length, 1);
	assert.equal(page.hasNextPage, true, 'one item with hasNextPage:true is still not the end');
	assert.equal(page.endCursor, 'c1');
});

test('unprojectable edges are counted, not silently dropped', () => {
	const page = toTimelinePage(
		{
			edges: [
				{ cursor: 'c1', node: lesserObject() },
				{ cursor: 'c2', node: { id: 'broken' } },
				{ cursor: 'c3', node: null },
			],
			pageInfo: { hasNextPage: false, endCursor: 'c3' },
		},
		{ viewerAuthenticated: false }
	);

	assert.equal(page.items.length, 1);
	assert.equal(page.skipped, 2, 'a silent drop is indistinguishable from a short page');
});

test('a malformed connection yields an empty page rather than throwing', () => {
	const page = toTimelinePage(null, { viewerAuthenticated: false });
	assert.deepEqual(page, { items: [], endCursor: null, hasNextPage: false, skipped: 0 });
});

/* ---------------------------------------------------------------------------
 * Auth rules — the query and the subscription disagree, deliberately
 * ------------------------------------------------------------------------ */

test('only HOME needs a token to READ', () => {
	assert.equal(readRequiresAuth('HOME'), true);
	assert.equal(readRequiresAuth('LOCAL'), false);
	assert.equal(readRequiresAuth('PUBLIC'), false);
	assert.equal(readRequiresAuth('ACTOR'), false);
});

test('realtime is stricter than reads: no timeline goes live without a token', () => {
	// TWO REFUSALS, AND THE STRICTER ONE IS THE ONE READERS MEET.
	// `subscription_resolvers_timelines.go` refuses any type but PUBLIC with no
	// username — so the RESOLVER would serve an anonymous PUBLIC subscriber. It
	// never gets the chance: `cmd/graphql-ws/main.go` → `handleConnectionInit`
	// answers a tokenless `connection_init` with `connection_error` before any
	// GraphQL dispatch, and `handleSubscribe` refuses a connection with no
	// username besides.
	//
	// PUBLIC therefore reads anonymously and cannot go live anonymously, and this
	// says so rather than advertising a stream that will be refused.
	assert.equal(
		realtimeAvailability('PUBLIC', false),
		'requires-auth',
		'GOOD NEWS IF THIS FAILS: lesser can now ACK an anonymous connection_init. ' +
			'Restore PUBLIC to `available` here and in realtimeAvailability, and drop the ' +
			'lesser filing from docs/consumption/timeline-contract.md.'
	);
	assert.equal(realtimeAvailability('LOCAL', false), 'requires-auth');
	assert.equal(realtimeAvailability('HOME', false), 'requires-auth');

	assert.equal(realtimeAvailability('PUBLIC', true), 'available');
	assert.equal(realtimeAvailability('LOCAL', true), 'available');
	assert.equal(realtimeAvailability('HOME', true), 'available');

	// Reads are UNTOUCHED by the realtime gate. This pairing is the assertion
	// that the gate did not quietly become a sign-in wall on the reading surface.
	assert.equal(readRequiresAuth('PUBLIC'), false);
	assert.equal(readRequiresAuth('LOCAL'), false);

	assert.equal(realtimeAvailability('ACTOR', true), 'unsupported');
	assert.equal(realtimeAvailability('ACTOR', false), 'unsupported');
});

/* ---------------------------------------------------------------------------
 * Failure taxonomy
 * ------------------------------------------------------------------------ */

test('lesser’s error text is classified into the screens it maps to', () => {
	assert.equal(classifyTimelineFailure([]), null, 'no errors is not a failure');
	assert.equal(
		classifyTimelineFailure([{ message: 'authentication required for this timeline type' }]),
		'auth-required'
	);
	assert.equal(
		classifyTimelineFailure([{ message: 'actorID is required for actor' }]),
		'unsupported'
	);
	assert.equal(classifyTimelineFailure([{ message: 'actor not found' }]), 'not-found');
	// Anything unrecognised becomes the honest "we cannot say what went wrong",
	// never a guess that happens to read nicely.
	assert.equal(
		classifyTimelineFailure([{ message: 'dynamodb throughput exceeded' }]),
		'unavailable'
	);
});
