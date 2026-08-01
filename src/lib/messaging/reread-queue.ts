/**
 * How many re-reads a burst of realtime events is allowed to have open at once.
 *
 * THE DEFECT THIS EXISTS FOR. `conversationUpdates` publishes ids, not messages,
 * so every event is a re-read. Collapsing them PER CONVERSATION — one read in
 * flight per id plus at most one trailing read — bounds a correspondent typing
 * quickly, and bounds nothing else: a hundred events naming a hundred DIFFERENT
 * conversations pass every per-id check and become a hundred concurrent
 * authenticated reads. That is not hypothetical on this surface. A quiet inbox
 * that has just been caught up, a mailing-list-shaped account, or an instance
 * republishing after its own restart all deliver exactly that shape, and the
 * client answers by opening a hundred sockets' worth of work against an instance
 * that has just told us it is busy.
 *
 * So there are two bounds, and they compose. The per-id collapse decides WHAT is
 * worth reading; this queue decides HOW MANY of those may be open at once. The
 * trailing edge survives both: an event for a conversation whose read is already
 * running is still owed a read, and still gets it after that one finishes, so
 * every conversation ends up consistent no matter how the burst was shaped.
 *
 * FAIR, AND NOT A STACK. Waiting ids run in the order they arrived. A queue that
 * drained newest-first would leave the first conversation in a long burst
 * unread for as long as the burst continued.
 *
 * Plain data on purpose: `tests/messaging-realtime.test.mjs` drives the queue
 * directly as well as through the real binding.
 */

/**
 * The budget.
 *
 * Four rather than one: a burst usually names a handful of conversations, and
 * serialising those onto a single connection would make an ordinary two-person
 * exchange wait behind an unrelated read. Four is enough concurrency to keep
 * that immediate and small enough that a hundred-event burst never looks like a
 * hundred-request one. It is a number to tune with evidence, not a contract.
 */
export const REREAD_CONCURRENCY = 4;

export interface RereadQueue {
	/**
	 * Ask for `id` to be read.
	 *
	 * Three outcomes, and which one happens is the whole point: a read already
	 * RUNNING for this id owes a trailing read; a read already WAITING for it is
	 * the same read, so the ask collapses into it; anything else joins the queue.
	 */
	enqueue: (id: string) => void;
	/** Reads open right now. Never above the limit; for probes and nothing else. */
	inFlight: () => number;
	/** Ids waiting for a slot. For probes. */
	waiting: () => number;
}

export function createRereadQueue(options: {
	/** What a read actually is. Reports its own failures; rejections are absorbed. */
	run: (id: string) => Promise<void>;
	limit?: number;
}): RereadQueue {
	const limit = Math.max(1, options.limit ?? REREAD_CONCURRENCY);

	/** Reads open right now, by conversation. */
	const running = new Set<string>();
	/** Ids waiting for a slot, oldest first, with a set beside it for the collapse. */
	const queue: string[] = [];
	const queued = new Set<string>();
	/** Ids that were asked for again while their read was open. */
	const owed = new Set<string>();

	function pump(): void {
		while (running.size < limit && queue.length > 0) {
			const id = queue.shift();
			if (id === undefined) return;
			queued.delete(id);
			running.add(id);

			let settled: Promise<unknown>;
			try {
				settled = options.run(id);
			} catch {
				// A runner that threw synchronously still has to give its slot back;
				// the alternative is a queue that stops draining after one bad read.
				settled = Promise.resolve();
			}

			void Promise.resolve(settled)
				.catch(() => {
					// The runner surfaces its own failures — a swallowed re-read is the
					// defect `handlers.ts` reports states for. Here it only frees a slot.
				})
				.finally(() => {
					running.delete(id);
					// The trailing read, issued only now, so the newest state for this
					// conversation is still the last one read.
					if (owed.delete(id)) enqueue(id);
					pump();
				});
		}
	}

	function enqueue(id: string): void {
		if (running.has(id)) {
			owed.add(id);
			return;
		}
		if (queued.has(id)) return;

		queued.add(id);
		queue.push(id);
		pump();
	}

	return {
		enqueue,
		inFlight: () => running.size,
		waiting: () => queue.length,
	};
}
