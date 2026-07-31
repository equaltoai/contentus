/**
 * The parts of lesser's `CreateNoteInput` the vendored compose context has no
 * room for.
 *
 * greater's `ComposeState` (`src/lib/components/compose/context.ts`) models the
 * Mastodon-shaped subset: content, visibility, content warning, media
 * attachments, reply target, and the Lesser quote fields. lesser's contract is
 * wider — `sensitive`, `poll`, `attachmentIds`, `quoteId`, `scheduledAt`, and
 * `agentAttribution` all exist on the write path and none of them appear in the
 * vendored state.
 *
 * Rather than hand-edit vendored source (never) or fork the compound (a
 * component reimplementation, which is upstream's work), the composer runs the
 * vendored context for what it models and this small companion store for what
 * it does not. Both are read together at submit time, in one place, by the
 * compose face.
 *
 * The shape here mirrors the contract exactly and holds nothing else. When
 * greater's compose state grows these fields, this file shrinks to whatever is
 * still missing — and ideally to nothing.
 *
 * Named with the `.svelte.` infix on purpose: `vite-plugin-svelte` only compiles
 * runes in a plain module when the filename carries it. Vendored greater modules
 * are swept in through `compileModule.include` in `vite.config.ts` as a
 * workaround for an upstream naming defect; contentus-owned modules use the
 * supported convention instead.
 */

import { getContext, setContext } from 'svelte';

import type { AgentPostAttributionInput, PollParamsInput } from '$lib/cms/compose';

const COMPOSE_EXTRAS_KEY = Symbol('contentus-compose-extras');

export interface ComposeExtrasState {
	/**
	 * lesser `CreateNoteInput.sensitive`. Independent of the content warning by
	 * contract: the resolver reads it on its own and never derives it from a
	 * spoiler being present.
	 */
	sensitive: boolean;
	/** Media ids returned by `uploadMedia`, in attachment order. */
	attachmentIds: string[];
	/** lesser `PollParamsInput`, or null when the post carries no poll. */
	poll: PollParamsInput | null;
	/** RFC 3339 instant for `scheduleStatus`, or null to post now. */
	scheduledAt: string | null;
	/** lesser `CreateNoteInput.inReplyToId`, from the source status. */
	inReplyToId: string | null;
	/** lesser `CreateNoteInput.quoteId`, from the source status. */
	quoteId: string | null;
	/**
	 * lesser `AgentPostAttributionInput`, set only when the operator is posting
	 * on an agent's behalf. Surfaced in the UI whenever it is non-null — an
	 * attribution the poster cannot see is not attribution.
	 */
	agentAttribution: AgentPostAttributionInput | null;
	/** Status id being edited via `updateStatus`, or null for a new post. */
	editingStatusId: string | null;
}

export interface ComposeExtras {
	state: ComposeExtrasState;
	update: (partial: Partial<ComposeExtrasState>) => void;
	reset: () => void;
}

function defaultState(): ComposeExtrasState {
	return {
		sensitive: false,
		attachmentIds: [],
		poll: null,
		scheduledAt: null,
		inReplyToId: null,
		quoteId: null,
		agentAttribution: null,
		editingStatusId: null,
	};
}

/**
 * Create the extras store and publish it to descendants.
 *
 * `initial` carries the fields a route resolved before the composer mounted —
 * a reply target from the query string, say — so they are part of the first
 * render rather than patched in afterwards.
 */
export function createComposeExtras(initial: Partial<ComposeExtrasState> = {}): ComposeExtras {
	const base = defaultState();
	const state = $state<ComposeExtrasState>({ ...base, ...initial });

	const extras: ComposeExtras = {
		state,
		update: (partial) => Object.assign(state, partial),
		reset: () => {
			// Reset to the ORIGINAL initial state, not to defaults: a reply
			// composer that cleared `inReplyToId` after posting would silently turn
			// the next post into a top-level one.
			Object.assign(state, defaultState(), initial);
		},
	};

	setContext(COMPOSE_EXTRAS_KEY, extras);
	return extras;
}

export function getComposeExtras(): ComposeExtras {
	const extras = getContext<ComposeExtras | undefined>(COMPOSE_EXTRAS_KEY);
	if (!extras) {
		throw new Error('Compose extras not found. Use this inside the contentus compose face.');
	}
	return extras;
}
