/**
 * What the reader is told about the live connection, from three signals rather
 * than one.
 *
 * WHY THREE. The socket's own state is the only one M5 shipped with, and it is
 * not enough to make "live" true. Two things can be wrong while the socket is
 * perfectly open:
 *
 *   1. **A gap.** `conversationUpdates` has no replay, so events published while
 *      the socket was down were never delivered and never will be. A reconnected
 *      socket is live for the FUTURE and silent about what it missed, and the
 *      only thing that closes the gap is a re-read.
 *   2. **A failed re-read.** Every event is an id, so the message is fetched
 *      over HTTP. That fetch can fail — most sharply when the session has
 *      expired — while the socket, authorized at connect time, keeps arriving.
 *      The strip says live and the thread stops growing.
 *
 * So the notice is derived from all three, and the ONLY combination that renders
 * nothing is a live socket with no gap and no failed re-read. Anything else is
 * named. `null` means "the connection is genuinely live", and it is the only
 * thing that means it.
 *
 * ORDER IS DELIBERATE: the states that need the reader to DO something come
 * first, because a screen showing two notices at once is a screen that has
 * chosen neither.
 */

import type { SubscriptionState } from '../timelines/subscription.ts';
import type { MessagingCatchUp, MessagingRereadState } from './handlers.ts';

export interface RealtimeNotice {
	text: string;
	/** `alert` when the reader has to act; `status` when it is only news. */
	tone: 'status' | 'alert';
	/** Whether to offer the sign-in control alongside the copy. */
	signIn: boolean;
}

export interface LivenessInput {
	/** The realtime state as OBSERVED by the socket. */
	socket: SubscriptionState;
	/** Whether a reconnected socket has re-read what it missed. */
	catchUp: MessagingCatchUp;
	/** What happened to the last re-read an event asked for. */
	reread: MessagingRereadState;
}

export function realtimeNotice({ socket, catchUp, reread }: LivenessInput): RealtimeNotice | null {
	// The session, first. It is the only failure here with an action attached,
	// and it never clears on its own.
	if (socket === 'requires-auth' || reread === 'auth-required') {
		return {
			tone: 'alert',
			signIn: true,
			text: 'Live messages stopped because this session expired. Sign in again to resume.',
		};
	}

	if (catchUp === 'catching-up') {
		return {
			tone: 'status',
			signIn: false,
			text: 'Reconnected. Checking for messages that arrived while the connection was down…',
		};
	}

	if (catchUp === 'failed') {
		return {
			tone: 'alert',
			signIn: false,
			text: 'Live messages are connected again, but the messages that arrived while the connection was down could not be loaded. Reload to be sure this thread is complete.',
		};
	}

	if (reread === 'failed') {
		return {
			tone: 'alert',
			signIn: false,
			text: 'Something new arrived, but this instance did not answer the request to read it. Reload to be sure this thread is complete.',
		};
	}

	switch (socket) {
		case 'live':
			return null;
		case 'connecting':
			return { tone: 'status', signIn: false, text: 'Connecting for live messages…' };
		case 'degraded':
			return {
				tone: 'alert',
				signIn: false,
				text: 'Live messages are arriving, but something this instance sent could not be read. Reload to be sure this thread is complete.',
			};
		case 'unsupported':
			return {
				tone: 'status',
				signIn: false,
				text: 'Live messages are unavailable on this instance. New messages appear when you reload.',
			};
		default:
			return {
				tone: 'status',
				signIn: false,
				text: 'Live messages are not connected. New messages appear when you reload.',
			};
	}
}

/**
 * Whether the connection may be described as live.
 *
 * One expression, so no surface can grow its own opinion of what live means.
 */
export function isLive(input: LivenessInput): boolean {
	return realtimeNotice(input) === null;
}
