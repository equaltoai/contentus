/**
 * Face 4's SSR probes.
 *
 * These drive the BUILT handler (`build/server/handler.mjs`) exactly as lesser's
 * SSR host does, so what is asserted is what ships — including whatever the
 * vendored components emit. Source inspection would be weaker evidence.
 *
 * Two classes of claim live here and they are different in kind. The
 * ANONYMOUS-SAFETY claims are about what the server must NOT do: no token, no
 * Home fetch, no protected data in a document that travels to a public
 * hydration endpoint. The RENDERING claims are about what a cold deep link must
 * produce, because lesser performs no SPA fallback under `/l/*` — a route that
 * renders empty here is empty on a phone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
	AUDIT_ROUTES,
	loadHandler,
	renderRoute,
	withStubbedGraphql,
} from '../scripts/render-routes.mjs';

const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

/** A lesser `Object` shaped as the timeline resolver returns one. */
function object(id, content, actor = 'ada') {
	return {
		id,
		type: 'NOTE',
		content,
		contentHash: `sha256:${id}`,
		visibility: 'PUBLIC',
		sensitive: false,
		spoilerText: null,
		createdAt: '2026-07-01T10:00:00Z',
		updatedAt: '2026-07-01T10:00:00Z',
		repliesCount: 0,
		likesCount: 0,
		sharesCount: 0,
		viewerFavourited: false,
		viewerBookmarked: false,
		viewerPinned: false,
		boosted: false,
		actor: {
			id: `actor-${actor}`,
			username: actor,
			domain: null,
			displayName: actor,
			summary: null,
			avatar: null,
			header: null,
			followers: 1,
			following: 1,
			statusesCount: 1,
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
	};
}

function timelineEnvelope(nodes) {
	return {
		data: {
			timeline: {
				edges: nodes.map((node, index) => ({ cursor: `c${index}`, node })),
				pageInfo: { hasNextPage: false, endCursor: `c${nodes.length - 1}` },
			},
		},
	};
}

/** A lesser `Actor` shaped as `actor(username:)` returns one. */
function actor(overrides = {}) {
	return {
		id: 'actor-ada',
		username: 'ada',
		domain: null,
		displayName: 'Ada Lovelace',
		summary: 'Writes about engines',
		avatar: null,
		header: null,
		followers: 12,
		following: 3,
		statusesCount: 40,
		bot: false,
		locked: false,
		createdAt: '2026-01-01T00:00:00Z',
		isAgent: false,
		...overrides,
	};
}

/**
 * An error on a field this client SELECTS and lesser declares nullable.
 *
 * `boostedObject` is the load-bearing example and the reason the marker exists:
 * a boost that failed to resolve arrives as `null` beside its error, which is
 * byte-identical to a post that simply is not a boost. An error on a field
 * nobody asked for would prove nothing, because the projection never looks at
 * it.
 */
const BOOSTED_OBJECT_ERROR = {
	message: 'failed to resolve boosted object',
	path: ['timeline', 'edges', 0, 'node', 'boostedObject'],
};

/** The copy each marker renders. Asserted as text, because that is what a reader gets. */
const FEED_PARTIAL_COPY = /Parts of these posts could not be loaded/;
const PROFILE_PARTIAL_COPY = /Parts of this profile could not be loaded/;

/* ---------------------------------------------------------------------------
 * Anonymous reads render real posts
 * ------------------------------------------------------------------------ */

test('an anonymous Instance read server-renders lesser’s statuses', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? timelineEnvelope([object('obj-1', '<p>Hello from the instance</p>')])
				: { data: null },
		() => renderRoute(handler, route('timelines-instance'))
	);

	assert.equal(value.status, 200);
	// The status itself — card, author, handle, timestamp, action bar — is in
	// the server's paint. The BODY is not, and that is the pinned upstream gap
	// asserted separately below; everything else about the post must be here.
	assert.ok(value.html.includes('class="status-card'), 'the status card must render server-side');
	assert.ok(value.html.includes('@ada'), 'with the author lesser named');
	assert.ok(value.html.includes('2026-07-01'), 'and the time lesser stamped');

	const timelineRequests = requests.filter((r) => r.operation === 'ContentusTimeline');
	assert.equal(timelineRequests.length, 1);
	assert.equal(timelineRequests[0].variables.type, 'LOCAL', 'the Instance tab reads LOCAL');
});

test('the Federated tab reads PUBLIC, from the same route', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? timelineEnvelope([object('obj-2', '<p>Hello from elsewhere</p>', 'grace')])
				: { data: null },
		() => renderRoute(handler, route('timelines-federated'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('@grace'), 'the federated author renders server-side');
	assert.equal(requests.find((r) => r.operation === 'ContentusTimeline').variables.type, 'PUBLIC');
});

/* ---------------------------------------------------------------------------
 * The gap that was pinned here, now closed
 * ------------------------------------------------------------------------ */

test('status bodies server-render, which is what the pinned gap used to deny', async () => {
	// THIS PROBE USED TO ASSERT THE OPPOSITE. `ContentRenderer` wrote its
	// sanitized output through a Svelte ACTION (`use:setHtml` → `node.innerHTML`),
	// actions do not run during SSR, and so the server emitted an empty
	// `<div class="content">` and the text appeared only at hydration. The probe
	// pinned that, and said in as many words that failing was the good news and
	// the forcing function.
	//
	// greater-v0.13.0 fixed it: the component renders `{@html processedContent}`
	// declaratively, so the body is in the server's paint. The probe is inverted
	// rather than deleted — the property a no-script reader depends on is now
	// worth protecting in the direction it actually matters.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? timelineEnvelope([object('obj-9', '<p>BODY-MARKER-TEXT</p>')])
				: { data: null },
		() => renderRoute(handler, route('timelines-instance'))
	);

	assert.ok(value.html.includes('class="status-content"'), 'the body container renders');
	assert.ok(
		value.html.includes('BODY-MARKER-TEXT'),
		'and the body itself is in the server’s paint, with no script at all'
	);
	// The markup survives as MARKUP rather than arriving escaped into literal
	// text — the second half of the same upstream fix (#926).
	assert.ok(
		!value.html.includes('&lt;p&gt;BODY-MARKER-TEXT'),
		'sanitized markup must not be escaped into literal text'
	);
});

test('the disclosure left with the fault, rather than outliving it', () => {
	// The feed used to carry two disclosures — an unconditional one about
	// corrupted post text, and a `<noscript>` one about text that never
	// server-rendered. greater-v0.13.0 closed both faults, and a disclosure that
	// outlives the fault it discloses teaches readers to ignore disclosures.
	//
	// This is a source check rather than a render check on purpose: the claim is
	// that the component no longer OWNS the text, not merely that one route did
	// not happen to show it.
	const source = readFileSync(
		new URL('../src/lib/timelines/TimelineFeed.svelte', import.meta.url),
		'utf8'
	);

	assert.ok(!source.includes('contentus-feed__gap'), 'the hydrated-corruption notice is gone');
	assert.ok(!source.includes('contentus-feed__noscript'), 'and the no-script notice with it');
});

test('a profile deep link server-renders the actor card AND their posts', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) => {
			if (operation === 'ContentusActor') {
				return { data: { actor: actor() } };
			}
			if (operation === 'ContentusTimeline') {
				return timelineEnvelope([object('obj-3', '<p>On the Analytical Engine</p>')]);
			}
			return { data: null };
		},
		() => renderRoute(handler, route('profile'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Ada Lovelace'), 'the actor card must render');
	assert.ok(value.html.includes('Writes about engines'), 'including the bio lesser returned');
	// The timeline renders as cards; the bodies inside them are the pinned
	// upstream gap asserted above.
	assert.ok(value.html.includes('class="status-card'), 'and their timeline with it');

	const timeline = requests.find((r) => r.operation === 'ContentusTimeline');
	assert.equal(timeline.variables.type, 'ACTOR');
	assert.equal(
		timeline.variables.actorId,
		'actor-ada',
		'the ACTOR timeline is keyed on the id the actor query returned, never on the username'
	);
});

/* ---------------------------------------------------------------------------
 * Half-failed reads — the marker has to survive the props boundary
 *
 * `tests/timeline-adapters.test.mjs` pins the TRANSPORT half: a read that
 * half-failed keeps its objects and reports `partial`. These pin the half that
 * was missing, and the reason it mattered. The server pass is the ONLY pass a
 * reader with no script gets and the first paint for everyone else, so a marker
 * that is set on the wire and dropped on the way to the component is a marker
 * that never reaches a reader — the page renders a timeline it believes is
 * whole, which is the exact claim the transport refused to make.
 * ------------------------------------------------------------------------ */

test('a half-failed timeline read renders its marker in the server’s paint', async () => {
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? {
						...timelineEnvelope([object('obj-5', '<p>Still worth showing</p>')]),
						errors: [BOOSTED_OBJECT_ERROR],
					}
				: { data: null },
		() => renderRoute(handler, route('timelines-instance'))
	);

	assert.equal(value.status, 200, 'losing a field is not losing the timeline');
	assert.ok(value.html.includes('class="status-card'), 'the objects that survived are shown');
	assert.match(
		value.html,
		/class="contentus-feed__partial"/,
		'and the document must carry the marker, not just the props behind it'
	);
	assert.match(value.html, FEED_PARTIAL_COPY, 'with copy that says what happened');
});

test('a clean timeline read renders no marker, or the marker would mean nothing', async () => {
	// The other half of the differential, at the SSR boundary this time. A marker
	// that is always on is a marker readers learn to ignore.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? timelineEnvelope([object('obj-6', '<p>Nothing failed here</p>')])
				: { data: null },
		() => renderRoute(handler, route('timelines-instance'))
	);

	assert.ok(value.html.includes('class="status-card'), 'the timeline still renders');
	assert.doesNotMatch(value.html, /class="contentus-feed__partial"/);
	assert.doesNotMatch(value.html, FEED_PARTIAL_COPY);
});

test('a half-failed read that carried NO objects still says so', async () => {
	// The state that had no marker on it at all: lesser answered, part of the
	// answer failed, and nothing survived to render. "No posts yet" here would be
	// this client asserting an emptiness that only half an answer supports.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? {
						data: { timeline: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
						errors: [BOOSTED_OBJECT_ERROR],
					}
				: { data: null },
		() => renderRoute(handler, route('timelines-instance'))
	);

	assert.match(value.html, /class="contentus-feed__partial"/);
	assert.match(value.html, /posts may be missing from it/);
	assert.ok(
		!value.html.includes('No posts yet'),
		'an empty state and a half-failed read cannot both be claimed'
	);
});

test('a half-failed ACTOR read marks the profile card, and only the card', async () => {
	// `fetchActor` carries its own marker and it was discarded before the props
	// ever reached the route. The two reads on this page fail independently, so
	// the markers are separate claims about separate elements: a `trustScore` that
	// failed says nothing about the posts below it.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) => {
			if (operation === 'ContentusActor') {
				return {
					data: { actor: actor({ trustScore: null }) },
					errors: [{ message: 'trust score unavailable', path: ['actor', 'trustScore'] }],
				};
			}
			if (operation === 'ContentusTimeline') {
				return timelineEnvelope([object('obj-7', '<p>On the Analytical Engine</p>')]);
			}
			return { data: null };
		},
		() => renderRoute(handler, route('profile'))
	);

	assert.equal(value.status, 200);
	assert.ok(value.html.includes('Ada Lovelace'), 'what resolved is still shown');
	assert.match(value.html, /class="contentus-profile__partial"/, 'and the card says it is partial');
	assert.match(value.html, PROFILE_PARTIAL_COPY);
	assert.doesNotMatch(
		value.html,
		/class="contentus-feed__partial"/,
		'the posts read cleanly, so nothing may claim otherwise about them'
	);
});

test('a half-failed profile TIMELINE marks the posts, and only the posts', async () => {
	// The mirror image, which is what makes the two markers evidence rather than
	// one marker rendered twice.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) => {
			if (operation === 'ContentusActor') return { data: { actor: actor() } };
			if (operation === 'ContentusTimeline') {
				return {
					...timelineEnvelope([object('obj-8', '<p>On the Analytical Engine</p>')]),
					errors: [BOOSTED_OBJECT_ERROR],
				};
			}
			return { data: null };
		},
		() => renderRoute(handler, route('profile'))
	);

	assert.match(value.html, /class="contentus-feed__partial"/);
	assert.match(value.html, FEED_PARTIAL_COPY);
	assert.doesNotMatch(
		value.html,
		/class="contentus-profile__partial"/,
		'the actor resolved completely, so the card may not say otherwise'
	);
});

test('the hydration payload carries the markers the document rendered from', async () => {
	// SSR and hydration are the same `createRouteProps` call, and this is what
	// holds them to it: if the marker reached the document but not the payload,
	// the feed would seed `partial = false` on mount and the disclosure would
	// vanish the moment the page became interactive.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? {
						...timelineEnvelope([object('obj-10', '<p>Still worth showing</p>')]),
						errors: [BOOSTED_OBJECT_ERROR],
					}
				: { data: null },
		() =>
			renderRoute(handler, {
				name: 'hydration-timelines',
				path: '/l/_facetheory/hydration?path=%2Ftimelines',
				expectStatus: 200,
			})
	);

	const props = JSON.parse(value.html);
	assert.equal(props.timelines.partial, true, 'the marker must travel to the hydrating client');
	assert.equal(props.timelines.page.items.length, 1, 'alongside the objects that survived');
});

/* ---------------------------------------------------------------------------
 * Anonymous safety — what the server must NOT do
 * ------------------------------------------------------------------------ */

test('NO server request on any face-4 route carries an Authorization header', async () => {
	// These props are serialized verbatim into a PUBLIC hydration endpoint. A
	// token on the server pass would put whatever it unlocked behind a URL
	// anyone could request.
	const handler = await loadHandler();

	for (const name of ['timelines-instance', 'timelines-federated', 'timelines-home', 'profile']) {
		const { requests } = await withStubbedGraphql(
			() => ({ data: null }),
			() => renderRoute(handler, route(name))
		);
		for (const request of requests) {
			assert.equal(
				request.authorization ?? null,
				null,
				`${name} made an authenticated server-side request`
			);
		}
	}
});

test('the Home tab is NEVER fetched on the server, and its document carries no timeline', async () => {
	const handler = await loadHandler();
	const { value, requests } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? timelineEnvelope([object('secret-1', '<p>A followed account posted this</p>')])
				: { data: null },
		() => renderRoute(handler, route('timelines-home'))
	);

	assert.equal(value.status, 200, 'the route exists for everyone; the timeline does not');
	assert.equal(
		requests.filter((r) => r.operation === 'ContentusTimeline').length,
		0,
		'a HOME read needs a token the server does not have — it must not be attempted'
	);
	assert.ok(
		!value.html.includes('A followed account posted this'),
		'and no timeline content may reach the anonymous document'
	);
	assert.ok(
		/sign in/i.test(value.html) || /session/i.test(value.html),
		'the document must explain itself rather than render blank'
	);
});

test('the anonymous document asserts no viewer state', async () => {
	// lesser answers `viewerFavourited: false` to an anonymous caller because the
	// field is `Boolean!`. That means "there is no viewer", and the projection
	// drops it rather than shipping it as a decided false.
	const handler = await loadHandler();
	const { value } = await withStubbedGraphql(
		({ operation }) =>
			operation === 'ContentusTimeline'
				? timelineEnvelope([
						{ ...object('obj-4', '<p>Body</p>'), viewerFavourited: true, boosted: true },
					])
				: { data: null },
		() => renderRoute(handler, route('timelines-instance'))
	);

	assert.ok(value.html.includes('class="status-card'), 'the status still renders');
	assert.ok(
		!/aria-pressed="true"/.test(value.html),
		'no action may render as engaged for a reader who is not signed in'
	);
});

/* ---------------------------------------------------------------------------
 * CSP — the subscription origin, and only where a socket opens
 * ------------------------------------------------------------------------ */

test('the timelines route permits exactly one wss origin, derived from the request host', async () => {
	const handler = await loadHandler();
	const rendered = await renderRoute(handler, route('timelines-instance'));
	const csp = rendered.headers['content-security-policy'];
	const connect = csp.split(';').find((directive) => directive.trim().startsWith('connect-src'));

	assert.ok(connect, 'connect-src must be present');
	// The host is the audit host injected as `x-lesser-forwarded-host`, so this
	// also proves the origin is DERIVED rather than configured or hard-coded.
	assert.match(connect, /wss:\/\/ws\.contentus-audit\.invalid/);
	assert.equal(
		connect.trim().split(/\s+/).length,
		3,
		"connect-src must be exactly 'self' plus the one subscription origin"
	);

	// Widening connect-src must not have widened anything else.
	assert.ok(!/unsafe-inline/i.test(csp));
	assert.ok(!/unsafe-eval/i.test(csp));
	assert.match(csp, /script-src 'self'(;|$)/);
});

test('routes that open no socket get no widening', async () => {
	const handler = await loadHandler();

	for (const name of ['profile', 'articles-index', 'compose', 'review-queue']) {
		const rendered = await renderRoute(handler, route(name));
		const connect = rendered.headers['content-security-policy']
			.split(';')
			.find((directive) => directive.trim().startsWith('connect-src'));

		assert.equal(
			connect.trim(),
			"connect-src 'self'",
			`${name} opens no subscription and must not permit one`
		);
	}
});

test('a request with no trusted forwarded host gets no widening at all', async () => {
	// `resolveRequestOrigin` fails closed when the edge-injected host is absent,
	// and the CSP addition must fail closed with it rather than emitting a
	// malformed or guessed origin.
	const handler = await loadHandler();
	const rendered = await renderRoute(handler, {
		...route('timelines-instance'),
		headers: { host: 'attacker.example' },
	});

	const connect = rendered.headers['content-security-policy']
		.split(';')
		.find((directive) => directive.trim().startsWith('connect-src'));

	assert.equal(connect.trim(), "connect-src 'self'");
	assert.ok(
		!/attacker\.example/.test(rendered.headers['content-security-policy']),
		'an untrusted Host header must never reach the policy'
	);
});

/* ---------------------------------------------------------------------------
 * Degraded rendering
 * ------------------------------------------------------------------------ */

test('an unreachable instance renders a designed state, never a blank or a 500', async () => {
	// The default audit pass has no stub at all, so every GraphQL fetch fails —
	// which is the cold/misconfigured-instance path a reader actually meets.
	const handler = await loadHandler();

	for (const name of ['timelines-instance', 'timelines-federated', 'profile']) {
		const rendered = await renderRoute(handler, route(name));
		assert.equal(rendered.status, 200, `${name} must not 500 when lesser is unreachable`);
		assert.ok(rendered.html.length > 1000, `${name} rendered a near-empty document`);
		assert.ok(
			/unavailable|not found|try again|no posts/i.test(rendered.html),
			`${name} must explain the absence rather than show a blank`
		);
	}
});

test('every face-4 route renders its tabs, so the surface is navigable with no script', async () => {
	const handler = await loadHandler();
	const rendered = await renderRoute(handler, route('timelines-instance'));

	// Links, not `role=tab`: each tab is a real address, and the control has to
	// work in the server's paint because lesser does no SPA fallback.
	assert.match(rendered.html, /href="\/l\/timelines"/);
	assert.match(rendered.html, /href="\/l\/timelines\?tab=federated"/);
	assert.match(rendered.html, /aria-current="page"/);
	// Home is auth-only and the server pass is always anonymous.
	assert.ok(
		!/href="\/l\/timelines\?tab=home"/.test(rendered.html),
		'the anonymous document must not offer a tab lesser would refuse'
	);
});
