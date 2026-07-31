/**
 * The reads the composer needs to offer completions: actors, hashtags, and the
 * instance's custom emoji.
 *
 * All three are anonymous-safe on lesser — `search` resolves the viewer with
 * `optionalAuth` and `customEmojis` is a public read — so these attach a token
 * only when one exists. A signed-out visitor drafting a post still gets
 * completions, which is the point of letting them draft at all.
 *
 * WHAT AUTOCOMPLETE ACTUALLY DOES HERE. It writes `@handle` and `#tag` into the
 * post text. It does NOT populate `CreateNoteInput.mentions`/`tags`: lesser's
 * resolver never reads those fields and the service extracts both from the
 * content itself (see the header of `./compose.ts`). So the completion menu is
 * a typing aid over the one path that works, not a second way to say the same
 * thing.
 */

import { accessTokenOrNull } from '$lib/auth/session';

import { graphqlRequest } from './graphql';

/** Matches the vendored `AutocompleteSuggestion` contract exactly. */
export interface AutocompleteSuggestion {
	type: 'hashtag' | 'mention' | 'emoji';
	text: string;
	value: string;
	metadata?: {
		username?: string;
		displayName?: string;
		avatar?: string;
		followers?: number;
	};
}

/** Matches the vendored `CustomEmojiPicker` emoji contract. */
export interface InstanceEmoji {
	shortcode: string;
	url: string;
	staticUrl?: string;
	category?: string;
	visibleInPicker?: boolean;
}

/**
 * lesser's `search(type:)` vocabulary. `canonicalGraphQLSearchType`
 * (`graph/query_resolvers_notes.go`) accepts `all`, `accounts`, `statuses`, and
 * `hashtags`; anything else is passed through lowercased and matches nothing.
 */
const SEARCH_ACCOUNTS = 'accounts';
const SEARCH_HASHTAGS = 'hashtags';

const SEARCH_ACCOUNTS_QUERY = `
	query ContentusSearchAccounts($query: String!, $first: Int) {
		search(query: $query, type: "${SEARCH_ACCOUNTS}", first: $first) {
			accounts { id username domain displayName avatar followers }
		}
	}
`;

const SEARCH_HASHTAGS_QUERY = `
	query ContentusSearchHashtags($query: String!, $first: Int) {
		search(query: $query, type: "${SEARCH_HASHTAGS}", first: $first) {
			hashtags { name url }
		}
	}
`;

const CUSTOM_EMOJIS_QUERY = `
	query ContentusCustomEmojis {
		customEmojis { shortcode url staticUrl category visibleInPicker }
	}
`;

const SUGGESTION_LIMIT = 10;

function requestOptions() {
	const accessToken = accessTokenOrNull();
	return accessToken ? { accessToken } : {};
}

/**
 * A fediverse handle as it must appear in the post text.
 *
 * Local actors are `@username`; remote ones carry the domain, because a bare
 * handle would resolve to whoever holds that name on this instance. lesser
 * returns `domain: null` for local actors, which is the distinction.
 */
function handleFor(username: string, domain: string | null): string {
	return domain ? `@${username}@${domain}` : `@${username}`;
}

async function searchAccounts(query: string): Promise<AutocompleteSuggestion[]> {
	const result = await graphqlRequest<{ search?: { accounts?: unknown } }>(
		SEARCH_ACCOUNTS_QUERY,
		{ query, first: SUGGESTION_LIMIT },
		requestOptions()
	);

	const accounts = result.data?.search?.accounts;
	if (!Array.isArray(accounts)) return [];

	return accounts.flatMap((raw) => {
		if (!raw || typeof raw !== 'object') return [];
		const actor = raw as Record<string, unknown>;
		const username = typeof actor['username'] === 'string' ? actor['username'] : '';
		if (!username) return [];

		const domain = typeof actor['domain'] === 'string' ? actor['domain'] : null;
		const displayName = typeof actor['displayName'] === 'string' ? actor['displayName'] : '';
		const handle = handleFor(username, domain);

		return [
			{
				type: 'mention' as const,
				text: displayName ? `${displayName} ${handle}` : handle,
				value: handle,
				metadata: {
					username,
					...(displayName ? { displayName } : {}),
					...(typeof actor['avatar'] === 'string' ? { avatar: actor['avatar'] } : {}),
					...(typeof actor['followers'] === 'number' ? { followers: actor['followers'] } : {}),
				},
			},
		];
	});
}

async function searchHashtags(query: string): Promise<AutocompleteSuggestion[]> {
	const result = await graphqlRequest<{ search?: { hashtags?: unknown } }>(
		SEARCH_HASHTAGS_QUERY,
		{ query, first: SUGGESTION_LIMIT },
		requestOptions()
	);

	const hashtags = result.data?.search?.hashtags;
	if (!Array.isArray(hashtags)) return [];

	return hashtags.flatMap((raw) => {
		if (!raw || typeof raw !== 'object') return [];
		const name = (raw as Record<string, unknown>)['name'];
		if (typeof name !== 'string' || !name) return [];
		const tag = name.startsWith('#') ? name : `#${name}`;
		return [{ type: 'hashtag' as const, text: tag, value: tag }];
	});
}

async function searchEmoji(query: string): Promise<AutocompleteSuggestion[]> {
	const emojis = await loadCustomEmojis();
	const needle = query.toLowerCase();

	return emojis
		.filter((emoji) => emoji.shortcode.toLowerCase().includes(needle))
		.slice(0, SUGGESTION_LIMIT)
		.map((emoji) => ({
			type: 'emoji' as const,
			text: `:${emoji.shortcode}:`,
			value: `:${emoji.shortcode}:`,
		}));
}

/**
 * The `searchHandler` the vendored `EditorWithAutocomplete` expects.
 *
 * Returns an empty list rather than throwing on any failure. A completion menu
 * that cannot reach the instance should quietly not appear; taking the composer
 * down because a suggestion lookup failed would trade the whole write path for
 * a convenience.
 */
export async function composeSearchHandler(
	query: string,
	type: 'hashtag' | 'mention' | 'emoji'
): Promise<AutocompleteSuggestion[]> {
	if (!query) return [];

	try {
		switch (type) {
			case 'mention':
				return await searchAccounts(query);
			case 'hashtag':
				return await searchHashtags(query);
			case 'emoji':
				return await searchEmoji(query);
			default:
				return [];
		}
	} catch {
		return [];
	}
}

let emojiCache: Promise<InstanceEmoji[]> | null = null;

/**
 * The instance's custom emoji, fetched once per page.
 *
 * `customEmojis` returns the whole set with no query argument, so it is fetched
 * once and filtered locally rather than re-requested per keystroke. The cache
 * is a module-level promise deliberately: it lives as long as the page and dies
 * with it, which is the right lifetime for a per-instance catalogue.
 */
export function loadCustomEmojis(): Promise<InstanceEmoji[]> {
	emojiCache ??= graphqlRequest<{ customEmojis?: unknown }>(
		CUSTOM_EMOJIS_QUERY,
		{},
		requestOptions()
	)
		.then((result) => {
			const emojis = result.data?.customEmojis;
			if (!Array.isArray(emojis)) return [];

			return emojis.flatMap((raw): InstanceEmoji[] => {
				if (!raw || typeof raw !== 'object') return [];
				const emoji = raw as Record<string, unknown>;
				const shortcode = typeof emoji['shortcode'] === 'string' ? emoji['shortcode'] : '';
				const url = typeof emoji['url'] === 'string' ? emoji['url'] : '';
				if (!shortcode || !url) return [];
				if (emoji['visibleInPicker'] === false) return [];

				return [
					{
						shortcode,
						url,
						...(typeof emoji['staticUrl'] === 'string' ? { staticUrl: emoji['staticUrl'] } : {}),
						...(typeof emoji['category'] === 'string' ? { category: emoji['category'] } : {}),
						visibleInPicker: true,
					},
				];
			});
		})
		.catch(() => []);

	return emojiCache;
}
