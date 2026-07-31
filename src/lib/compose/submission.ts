/**
 * What pressing Post actually sends.
 *
 * The composer reads two stores at submit time — the vendored compose context
 * for content, visibility, and the content warning, and the extras store for
 * everything lesser's contract has that greater's state does not — and turns
 * them into ONE of three mutations. Which one, and with which fields, is the
 * decision this module states.
 *
 * It lives apart from the route for the same reason `cms/compose-inputs.ts`
 * does: this is where a reply's reach becomes a `visibility` argument and an
 * emptied warning becomes a `spoilerText: ""`, and rules with that
 * consequence should be readable in one place and loadable by a probe without
 * a bundler in between. The route keeps what a route should keep — awaiting,
 * failure display, and what to show afterwards.
 *
 * Deliberately pure: no network, no store access, no `$state`. Everything it
 * needs arrives as an argument, which is also what makes "reply to a DIRECT
 * status sends DIRECT" a thing a test can assert about shipped code rather
 * than about a copy of the rule.
 */

import type { ComposeMode } from '../../facetheory/types';

import type {
	CreateNoteInput,
	ScheduleStatusInput,
	UpdateStatusInput,
} from '../cms/compose-inputs';
import { toLesserVisibility } from '../cms/visibility.ts';
import { STATUS_BYTE_LIMIT, statusByteLength } from './budget.ts';
import type { ComposeExtrasState } from './extras.svelte';

/** What `Compose.Root` hands its `onSubmit` handler. */
export interface ComposeFormData {
	content: string;
	visibility: string;
	/** Undefined when the CW toggle is off — `Root` only forwards it when on. */
	contentWarning?: string | undefined;
}

/**
 * The three shapes a submit can take, plus the refusal.
 *
 * A tagged union rather than three functions because the choice between them
 * is itself part of the rule: a scheduled post is not a note, and an edit is
 * neither.
 */
export type ComposeSubmission =
	| { kind: 'rejected'; message: string }
	| { kind: 'update'; id: string; input: UpdateStatusInput }
	| { kind: 'schedule'; input: ScheduleStatusInput }
	| { kind: 'create'; input: CreateNoteInput };

export interface ComposeSubmissionArgs {
	mode: ComposeMode;
	form: ComposeFormData;
	extras: ComposeExtrasState;
}

/**
 * Decide what to send.
 *
 * THE BYTE GUARD comes first, and refuses rather than truncating. lesser
 * measures UTF-8 bytes (`len(content)` in Go) and the vendored counter
 * measures UTF-16 units, so a post can pass the on-screen counter and still be
 * rejected by the instance; refusing here means the composer's answer and the
 * instance's always agree.
 *
 * AN EDIT carries no visibility and no poll, because `UpdateStatusInput`
 * carries neither — lesser saying a posted status keeps its reach and a poll
 * with votes is not rewritten underneath them. It sends `spoilerText`
 * unconditionally, empty string included: the resolver seeds that field from
 * the stored status and replaces it only when the input carries it, so an
 * omitted-because-emptied warning would leave the old one standing.
 *
 * A SCHEDULED POST spells the body `text` and attachments `mediaIds`, and has
 * no `quoteId` — so a scheduled quote is not expressible, which is why the
 * composer disables one when the other is set rather than dropping it
 * silently.
 *
 * A NEW NOTE is everything else. `visibility` is whatever the poster left the
 * selector at, which for a reply or a quote was seeded from the reach of the
 * post being answered (`./seed`) and is therefore never wider than it unless
 * the poster widened it themselves.
 */
export function buildComposeSubmission({
	mode,
	form,
	extras,
}: ComposeSubmissionArgs): ComposeSubmission {
	const bytes = statusByteLength(form.content, form.contentWarning ?? '');
	if (bytes > STATUS_BYTE_LIMIT) {
		return {
			kind: 'rejected',
			message: `This post is ${bytes} bytes and the instance accepts ${STATUS_BYTE_LIMIT}.`,
		};
	}

	if (mode === 'edit' && extras.editingStatusId) {
		return {
			kind: 'update',
			id: extras.editingStatusId,
			input: {
				content: form.content,
				sensitive: extras.sensitive,
				spoilerText: form.contentWarning ?? '',
				...(extras.attachmentIds.length ? { attachmentIds: extras.attachmentIds } : {}),
			},
		};
	}

	// Omitted rather than sent empty: a post with no warning is not a post
	// asserting an empty one. The edit path above is the exception, and the
	// only one, because there it is how a warning is removed.
	const spoiler = form.contentWarning ? { spoilerText: form.contentWarning } : {};

	if (extras.scheduledAt) {
		return {
			kind: 'schedule',
			input: {
				text: form.content,
				scheduledAt: extras.scheduledAt,
				visibility: toLesserVisibility(form.visibility),
				sensitive: extras.sensitive,
				...spoiler,
				...(extras.inReplyToId ? { inReplyToId: extras.inReplyToId } : {}),
				...(extras.attachmentIds.length ? { mediaIds: extras.attachmentIds } : {}),
				...(extras.poll ? { poll: extras.poll } : {}),
			},
		};
	}

	return {
		kind: 'create',
		input: {
			content: form.content,
			visibility: toLesserVisibility(form.visibility),
			sensitive: extras.sensitive,
			...spoiler,
			...(extras.attachmentIds.length ? { attachmentIds: extras.attachmentIds } : {}),
			...(extras.poll ? { poll: extras.poll } : {}),
			...(extras.inReplyToId ? { inReplyToId: extras.inReplyToId } : {}),
			...(extras.quoteId ? { quoteId: extras.quoteId } : {}),
			...(extras.agentAttribution ? { agentAttribution: extras.agentAttribution } : {}),
		},
	};
}
