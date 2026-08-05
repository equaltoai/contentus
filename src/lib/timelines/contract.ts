/**
 * Face 4's consumption of lesser's timeline contract: the documents contentus
 * sends, the projection it builds from the answers, and the failure taxonomy it
 * reads out of lesser's errors.
 *
 * Same split as `cms/review-contract.ts`, for the same reason: everything here
 * decides WHAT GOES OVER THE WIRE and WHAT THE CLIENT BELIEVES CAME BACK, and
 * rules that consequential deserve probes that load the shipped code directly,
 * with no bundler and no alias resolver in between. Imports are relative and
 * carry explicit `.ts` extensions so `node --test --experimental-strip-types`
 * can drive this module as-is. The network calls live in `transport.ts`.
 *
 * Verified against lesser at `graph/core.graphql` and
 * `graph/query_resolvers_notes.go`.
 *
 * FOUR CONTRACT FACTS THIS FILE ENCODES, each of which changed the UI.
 *
 * 1. AUTH IS PER TIMELINE TYPE, AND THE QUERY AND THE SUBSCRIPTION DISAGREE.
 *    `applyTimelineTypeFilter` requires a username for HOME and DIRECT only, so
 *    LOCAL, PUBLIC and ACTOR read anonymously. The subscription is stricter,
 *    and stricter still than its own resolver: `TimelineUpdates` refuses every
 *    type except PUBLIC without a username, and the WebSocket gateway in front
 *    of it refuses EVERY tokenless connection before the resolver is reached.
 *    So the timelines read for everyone and go live only once signed in, and
 *    saying so is `realtimeAvailability` below rather than a dead socket.
 *
 * 2. `excludeAgents` FILTERS AFTER PAGINATION. The resolver fetches a page, then
 *    drops agent-authored objects from the edges it returns
 *    (`timelineObjectEdges`), while `hasNextPage` still comes from the
 *    pre-filter cursor. A short page is therefore NOT the end of the timeline,
 *    and only `pageInfo.hasNextPage` may decide that.
 *
 * 3. `totalCount` IS THE PAGE LENGTH, NOT A TOTAL. The resolver literally
 *    returns `len(edges)`. No document below selects it — a field that cannot
 *    mean what its name says is safer absent than explained, because the
 *    explanation does not travel with the value.
 *
 * 4. VIEWER STATE IS `Boolean!`, SO ANONYMOUS GETS `false`, NOT `null`.
 *    `ViewerFavourited` returns `false` the moment there is no username in
 *    context. That `false` means "there is no viewer", not "this viewer has not
 *    favourited it", and the two are not the same claim. `toTimelineStatus`
 *    therefore takes `viewerAuthenticated` and leaves the viewer fields
 *    UNDEFINED when it is false, so the action bar renders neutral rather than
 *    asserting a state nobody holds. This is the M2d honest-states rule applied
 *    to a field lesser cannot express as unknown.
 *
 * NOT USED, DELIBERATELY: the vendored `mapLesserObject` in
 * `greater/adapters/mappers/lesser`. It hardcodes `favourited: false,
 * reblogged: false, bookmarked: false, pinned: false` and never reads lesser's
 * `viewer*` fields at all, so an authenticated reader's own favourites would
 * render un-favourited. Routed upstream; see docs/consumption/timeline-contract.md.
 */

import type { Account, MediaAttachment, Mention, Status, Tag } from '../types.ts';
import { fromLesserVisibility, normalizeVisibility } from '../cms/visibility.ts';
import type { GraphQLError } from '../cms/graphql.ts';

/* -------------------------------------------------------------------------
 * Timeline types
 * ---------------------------------------------------------------------- */

/** lesser's `TimelineType` enum, verbatim. */
export type LesserTimelineType =
	'HOME' | 'PUBLIC' | 'LOCAL' | 'HASHTAG' | 'LIST' | 'DIRECT' | 'ACTOR';

/**
 * The subset face 4 addresses. HASHTAG, LIST and DIRECT are real contract
 * members contentus does not surface yet; they are absent from this union
 * rather than present-and-unreachable, so a tab for one cannot be added
 * without also deciding what it reads.
 */
export type ContentusTimelineType = Extract<
	LesserTimelineType,
	'HOME' | 'PUBLIC' | 'LOCAL' | 'ACTOR'
>;

/**
 * Whether lesser will answer this timeline for a caller with no token.
 *
 * Read straight off `applyTimelineTypeFilter`: HOME and DIRECT are the only
 * types that demand a username. Asking anyway would spend a round trip to be
 * told no, and would render an error where the honest answer is "sign in".
 */
export function readRequiresAuth(type: ContentusTimelineType): boolean {
	return type === 'HOME';
}

/**
 * Whether lesser will accept a `timelineUpdates` subscription for this type and
 * this caller — a separate question from `readRequiresAuth`, and the reason the
 * two are separate functions rather than one flag.
 *
 * TWO REFUSALS, AND THE STRICTER ONE IS THE ONE READERS MEET.
 * `subscription_resolvers_timelines.go` refuses any type but PUBLIC when the
 * connection carries no username — so the resolver would serve an anonymous
 * PUBLIC subscriber. It never gets the chance: the WebSocket gateway in front
 * of it (`cmd/graphql-ws/main.go` → `handleConnectionInit`) requires an access
 * token in the `connection_init` payload and answers an empty one with
 * `connection_error` before any GraphQL dispatch, and `handleSubscribe` refuses
 * a connection with no username besides.
 *
 * That contradiction is lesser's and is filed as lesser's. What contentus owes
 * a reader in the meantime is the truth about what will happen, so realtime is
 * gated on a token for EVERY type: the Federated tab reads anonymously and
 * says "sign in to see it update live", which is what the instance will do,
 * rather than advertising a stream that cannot open. Reads are untouched —
 * only realtime is gated. When lesser can ACK an anonymous connection, PUBLIC
 * comes back here and the probe that pins this goes red.
 */
export function realtimeAvailability(
	type: ContentusTimelineType,
	viewerAuthenticated: boolean
): 'available' | 'requires-auth' | 'unsupported' {
	if (type === 'ACTOR') return 'unsupported';
	return viewerAuthenticated ? 'available' : 'requires-auth';
}

/* -------------------------------------------------------------------------
 * Documents
 * ---------------------------------------------------------------------- */

/**
 * The actor projection every status header and the profile card render.
 *
 * `isAgent` is read rather than inferred, for the same reason face 2 reads it:
 * lesser publishes the signal, so guessing it from a username would be
 * contentus inventing something the contract already states.
 */
const ACTOR_FIELDS = `
	id
	username
	domain
	displayName
	summary
	avatar
	header
	followers
	following
	statusesCount
	bot
	locked
	createdAt
	isAgent
`;

/**
 * The object projection, minus the boost target.
 *
 * Split from `OBJECT_FIELDS` so a boost can select the same shape one level
 * down without recursing forever — lesser's `boostedObject` is itself an
 * `Object`, and GraphQL has no way to say "the same fragment, one deeper".
 * Two levels is the whole requirement: a boost of a boost renders as a boost of
 * whatever the inner one carried.
 */
const OBJECT_CORE_FIELDS = `
	id
	type
	content
	contentHash
	visibility
	sensitive
	spoilerText
	createdAt
	updatedAt
	repliesCount
	likesCount
	sharesCount
	viewerFavourited
	viewerBookmarked
	viewerPinned
	actor { ${ACTOR_FIELDS} }
	attachments { id type url preview description blurhash width height duration }
	tags { name url }
	mentions { id username domain url }
	inReplyTo { id actor { id } }
	agentAttribution { triggerType modelId delegatedBy approvedBy schemaVersion }
`;

const OBJECT_FIELDS = `
	${OBJECT_CORE_FIELDS}
	boostedObject { ${OBJECT_CORE_FIELDS} }
`;

/**
 * The one timeline document, following sim's proven
 * `TIMELINE_WITH_VIEWER_STATE_QUERY` shape: one query parameterised by type,
 * not a query per tab.
 *
 * `totalCount` is deliberately not selected — see fact 3 in the module header.
 */
export const TIMELINE_QUERY = `
	query ContentusTimeline(
		$type: TimelineType!
		$first: Int
		$after: Cursor
		$actorId: ID
		$mediaOnly: Boolean
		$excludeAgents: Boolean
	) {
		timeline(
			type: $type
			first: $first
			after: $after
			actorId: $actorId
			mediaOnly: $mediaOnly
			excludeAgents: $excludeAgents
		) {
			edges {
				cursor
				node { ${OBJECT_FIELDS} }
			}
			pageInfo {
				hasNextPage
				endCursor
			}
		}
	}
`;

/** The profile header. `actor(username:)` is anonymous-safe per lesser's own public-read list. */
export const ACTOR_QUERY = `
	query ContentusActor($username: String!) {
		actor(username: $username) {
			${ACTOR_FIELDS}
			fields { name value verifiedAt }
			trustScore
		}
	}
`;

/**
 * The realtime document. `timelineUpdates` yields a bare `Object!`, not an
 * edge, so there is no cursor on a live item — which is why prepended items
 * carry no cursor and pagination continues from the last PAGED cursor.
 */
export const TIMELINE_UPDATES_SUBSCRIPTION = `
	subscription ContentusTimelineUpdates($type: TimelineType!) {
		timelineUpdates(type: $type) { ${OBJECT_FIELDS} }
	}
`;

/* -------------------------------------------------------------------------
 * Projection
 * ---------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * lesser's `Attachment.type` is a free `String!`; the card's is a closed union.
 * An unrecognised kind renders as an image rather than being dropped: the
 * attachment exists and saying nothing about it would be a worse lie than
 * showing it in the most conservative frame available.
 */
function attachmentType(value: unknown): MediaAttachment['type'] {
	const kind = String(value ?? '').toLowerCase();
	if (kind === 'video') return 'video';
	if (kind === 'audio') return 'audio';
	if (kind === 'gifv') return 'gifv';
	return 'image';
}

/**
 * The actor's fediverse handle.
 *
 * lesser splits `username` and `domain`, and leaves `domain` null for a local
 * actor. Mastodon's `acct` is exactly that join, so the join happens here once
 * rather than in every component that wants to print a handle.
 */
export function actorHandle(username: string, domain: string | null | undefined): string {
	const host = str(domain);
	return host ? `${username}@${host}` : username;
}

/** Project a lesser `Actor` onto the vendored components' `Account`. */
export function toAccount(raw: unknown): Account | null {
	if (!isRecord(raw)) return null;

	const id = str(raw['id']);
	const username = str(raw['username']);
	if (!id || !username) return null;

	const domain = typeof raw['domain'] === 'string' ? raw['domain'] : null;

	return {
		id,
		username,
		acct: actorHandle(username, domain),
		displayName: str(raw['displayName']) ?? username,
		avatar: str(raw['avatar']) ?? '',
		header: str(raw['header']),
		note: str(raw['summary']),
		// lesser's Actor carries no profile URL, so the client addresses the
		// actor by the route it owns. It is deliberately NOT a guess at the
		// remote profile's canonical URL: identity is lesser's to state, and it
		// does not state this one.
		url: `/profiles/${encodeURIComponent(actorHandle(username, domain))}`,
		followersCount: num(raw['followers']),
		followingCount: num(raw['following']),
		statusesCount: num(raw['statusesCount']),
		bot: raw['bot'] === true,
		locked: raw['locked'] === true,
		createdAt: str(raw['createdAt']) ?? '',
		isAgent: raw['isAgent'] === true,
		...(typeof raw['trustScore'] === 'number' ? { trustScore: raw['trustScore'] } : {}),
	};
}

/**
 * Project a lesser `Object` onto the vendored `Status` the card renders.
 *
 * `viewerAuthenticated` is not a convenience — see fact 4 in the module header.
 * When it is false the three viewer fields are left off the result entirely, so
 * `favourited`/`reblogged`/`bookmarked` are `undefined` (unknown) rather than
 * `false` (known not to be), and the action bar has something honest to render.
 *
 * `content` is passed through untouched. It is lesser's server-sanitized HTML
 * and contentus does not transform, truncate, excerpt or re-render it; the
 * vendored `ContentRenderer` sanitizes again on the way to the DOM, which is
 * defence in depth over lesser's authority rather than a second renderer.
 */
export function toTimelineStatus(
	raw: unknown,
	options: { viewerAuthenticated: boolean }
): Status | null {
	if (!isRecord(raw)) return null;

	const id = str(raw['id']);
	const account = toAccount(raw['actor']);
	if (!id || !account) return null;

	const boosted = isRecord(raw['boostedObject'])
		? toTimelineStatus(raw['boostedObject'], options)
		: null;

	const inReplyTo = isRecord(raw['inReplyTo']) ? raw['inReplyTo'] : null;
	const replyAccount = inReplyTo && isRecord(inReplyTo['actor']) ? inReplyTo['actor'] : null;

	const attachments = Array.isArray(raw['attachments'])
		? raw['attachments'].filter(isRecord).map((item): MediaAttachment => {
				const meta: { width?: number; height?: number; duration?: number } = {};
				if (typeof item['width'] === 'number') meta.width = item['width'];
				if (typeof item['height'] === 'number') meta.height = item['height'];
				if (typeof item['duration'] === 'number') meta.duration = item['duration'];

				return {
					id: str(item['id']) ?? '',
					type: attachmentType(item['type']),
					url: str(item['url']) ?? '',
					previewUrl: str(item['preview']),
					description: str(item['description']),
					blurhash: str(item['blurhash']),
					...(Object.keys(meta).length ? { meta } : {}),
				};
			})
		: [];

	const tags: Tag[] = Array.isArray(raw['tags'])
		? raw['tags']
				.filter(isRecord)
				.map((tag) => ({ name: str(tag['name']) ?? '', url: str(tag['url']) ?? '' }))
				.filter((tag) => tag.name)
		: [];

	const mentions: Mention[] = Array.isArray(raw['mentions'])
		? raw['mentions']
				.filter(isRecord)
				.map((mention) => {
					const username = str(mention['username']) ?? '';
					const domain = typeof mention['domain'] === 'string' ? mention['domain'] : null;
					return {
						id: str(mention['id']) ?? '',
						username,
						acct: actorHandle(username, domain),
						url: str(mention['url']) ?? '',
					};
				})
				.filter((mention) => mention.username)
		: [];

	// Only attached when a token was sent. See fact 4.
	const viewer = options.viewerAuthenticated
		? {
				favourited: raw['viewerFavourited'] === true,
				bookmarked: raw['viewerBookmarked'] === true,
				pinned: raw['viewerPinned'] === true,
				reblogged: raw['boosted'] === true,
			}
		: {};

	const status: Status = {
		id,
		// lesser's Object exposes no `uri`/`url`; `contentHash` is not an
		// address and must not be dressed as one. The status is addressed by
		// the route contentus owns, and federated identity stays lesser's.
		uri: id,
		url: `/statuses/${encodeURIComponent(id)}`,
		account,
		content: typeof raw['content'] === 'string' ? raw['content'] : '',
		createdAt: str(raw['createdAt']) ?? '',
		// NARROW on an unrecognised value, so the two are composed rather than
		// `fromLesserVisibility` used alone. That function widens to `public`,
		// which is correct where it was written — seeding a form control — and
		// wrong here: this value becomes the badge on somebody's post, and
		// labelling a reach the client failed to parse as "public" is how a
		// followers-only status gets shown as world-readable. `normalizeVisibility`
		// collapses anything unknown to DIRECT first, so a drift in lesser's enum
		// under-promises reach instead of over-promising it.
		visibility: fromLesserVisibility(
			normalizeVisibility(typeof raw['visibility'] === 'string' ? raw['visibility'] : null)
		),
		sensitive: raw['sensitive'] === true,
		repliesCount: num(raw['repliesCount']),
		reblogsCount: num(raw['sharesCount']),
		favouritesCount: num(raw['likesCount']),
		mediaAttachments: attachments,
		mentions,
		tags,
		...viewer,
	};

	const spoiler = str(raw['spoilerText']);
	if (spoiler) status.spoilerText = spoiler;

	const contentHash = str(raw['contentHash']);
	if (contentHash) status.contentHash = contentHash;

	const editedAt = str(raw['updatedAt']);
	if (editedAt && editedAt !== status.createdAt) status.editedAt = editedAt;

	if (inReplyTo) {
		const replyId = str(inReplyTo['id']);
		if (replyId) status.inReplyToId = replyId;
		const replyAccountId = replyAccount ? str(replyAccount['id']) : undefined;
		if (replyAccountId) status.inReplyToAccountId = replyAccountId;
	}

	if (boosted) status.reblog = boosted;

	// Agent attribution is surfaced whenever lesser records it. The field names
	// are lesser's own (`AgentPostAttribution`) and map onto the vendored
	// `AgentAttribution` one-for-one; nothing here is derived or guessed, which
	// is the point — attribution that a client inferred is not attribution.
	//
	// `approvedBy` (lesser v1.6.0) wins over `delegatedBy` when lesser sets it.
	// Both are server-derived — neither has been client-suppliable — but they
	// are not the same claim: `approvedBy` is populated only from a delegation
	// credential lesser VALIDATED for this specific post, while `delegatedBy`
	// otherwise carries what the caller's token claims say. lesser itself
	// collapses the two, overwriting `delegatedBy` with `approvedBy` whenever
	// the latter is non-empty (`graph/mutation_resolvers_notes.go`), so this
	// preference does not change the string contentus displays today. It makes
	// the display depend on the field that MEANS "verified approver" rather
	// than on lesser continuing to mirror it into the weaker one.
	//
	// The vendored `AgentAttribution` has no `approvedBy` slot, so the value
	// lands in `delegatedBy` — the vendored shape is greater's to extend, and
	// hand-editing it to add a field would break the CLI-managed channel for a
	// value that is already correct in the slot that exists.
	if (isRecord(raw['agentAttribution'])) {
		const attribution = raw['agentAttribution'];
		status.agentAttribution = {
			triggerType: str(attribution['triggerType']) ?? null,
			delegatedBy: str(attribution['approvedBy']) ?? str(attribution['delegatedBy']) ?? null,
			schemaVersion: str(attribution['schemaVersion']) ?? null,
			modelId: str(attribution['modelId']) ?? null,
		};
	}

	return status;
}

/* -------------------------------------------------------------------------
 * Pages
 * ---------------------------------------------------------------------- */

export interface TimelinePage {
	items: Status[];
	endCursor: string | null;
	/**
	 * lesser's own `pageInfo.hasNextPage`, never inferred from page length.
	 * `excludeAgents` shortens pages after the cursor is computed, so a page of
	 * three when twenty were asked for says nothing about whether more exist.
	 */
	hasNextPage: boolean;
	/**
	 * Objects lesser returned that this client could not project — almost
	 * always a contract addition it predates. Counted rather than swallowed so
	 * "12 of 20 items could not be displayed" is sayable; a silent drop looks
	 * identical to a short page.
	 */
	skipped: number;
}

/**
 * Read a timeline connection into a page.
 *
 * A malformed connection yields an EMPTY page rather than throwing, and the
 * caller distinguishes it from a genuine empty timeline by the errors it was
 * handed alongside. That distinction is the whole point of the failure taxonomy
 * below: "no posts yet" and "we could not read the posts" are different screens.
 */
export function toTimelinePage(
	raw: unknown,
	options: { viewerAuthenticated: boolean }
): TimelinePage {
	const connection = isRecord(raw) ? raw : null;
	const edges = connection && Array.isArray(connection['edges']) ? connection['edges'] : [];
	const pageInfo = connection && isRecord(connection['pageInfo']) ? connection['pageInfo'] : null;

	const items: Status[] = [];
	let skipped = 0;

	for (const edge of edges) {
		if (!isRecord(edge)) {
			skipped += 1;
			continue;
		}
		const status = toTimelineStatus(edge['node'], options);
		if (status) items.push(status);
		else skipped += 1;
	}

	return {
		items,
		endCursor: pageInfo ? (str(pageInfo['endCursor']) ?? null) : null,
		hasNextPage: pageInfo ? pageInfo['hasNextPage'] === true : false,
		skipped,
	};
}

/* -------------------------------------------------------------------------
 * Failure taxonomy
 * ---------------------------------------------------------------------- */

/**
 * Why a timeline has nothing to show.
 *
 * Separated because they are different screens with different actions.
 * `auth-required` offers sign-in, `unavailable` offers retry, and `empty` — the
 * absence of any reason at all — is the only one that says "nothing here yet".
 * Collapsing them is how a signed-out reader gets told the instance has no
 * posts.
 */
export type TimelineFailure = 'auth-required' | 'not-found' | 'unsupported' | 'unavailable';

const AUTH_MARKERS = [
	'authentication required',
	'unauthorized',
	'unauthenticated',
	'requires auth',
];
const NOT_FOUND_MARKERS = ['not found', 'no such actor', 'unknown actor'];
const UNSUPPORTED_MARKERS = ['unsupported timeline', 'is required for'];

/**
 * Classify lesser's errors, or null when none of them are fatal to the read.
 *
 * Matched on message text because lesser's timeline resolvers return plain
 * `errors.New` values with no extension code to key on — a contract gap routed
 * upstream rather than papered over. The matching is deliberately narrow: an
 * error this list does not recognise becomes `unavailable`, which is the
 * honest "something went wrong and we cannot say what".
 */
export function classifyTimelineFailure(errors: readonly GraphQLError[]): TimelineFailure | null {
	if (!errors.length) return null;

	const messages = errors.map((error) => String(error.message ?? '').toLowerCase());
	const any = (markers: string[]) =>
		messages.some((message) => markers.some((marker) => message.includes(marker)));

	if (any(AUTH_MARKERS)) return 'auth-required';
	if (any(NOT_FOUND_MARKERS)) return 'not-found';
	if (any(UNSUPPORTED_MARKERS)) return 'unsupported';
	return 'unavailable';
}

/** Reader-facing copy for each failure. Never carries a raw server message. */
export const TIMELINE_FAILURE_COPY: Record<TimelineFailure, { title: string; detail: string }> = {
	'auth-required': {
		title: 'Sign in to see this timeline',
		detail: 'This instance only shares this timeline with signed-in readers.',
	},
	'not-found': {
		title: 'Not found',
		detail: 'This instance does not know an actor by that name.',
	},
	unsupported: {
		title: 'Not available here',
		detail: 'This instance does not offer this timeline.',
	},
	unavailable: {
		title: 'Timeline unavailable',
		detail: 'This instance did not answer. Nothing has been lost — try again.',
	},
};
