import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accessLedger, grantStamp } from '../src/lib/agents/share-view.ts';

/**
 * The owner's read of one agent's share list (M2.3, equaltoai/contentus#94).
 *
 * WHAT THIS IS EVIDENCE FOR: that the split the owner sees is lesser's own
 * `active` boolean rather than a re-derivation of it, that an entry lesser did
 * not classify lands on neither side, and that an audit stamp drops a clause
 * lesser did not serve rather than filling it in.
 *
 * WHAT IT IS NOT: evidence about who may READ this list. That is lesser's —
 * `ListByAgent` authorizes the owner or an admin and answers everyone else
 * `ErrNotAuthorized` — and no arrangement of this module could grant or
 * withhold it.
 */

/** One grant as lesser serves it, with the fields under test overridable. */
function grant(overrides = {}) {
	return {
		active: true,
		agent_username: 'scribe',
		granted_at: '2026-03-01T00:00:00Z',
		granted_by: 'owner',
		grantee_username: 'editor',
		revoked_at: null,
		revoked_by: null,
		...overrides,
	};
}

/** A fixed date format, so the assertions are about composition, not ICU. */
const fixed = () => '1 Mar 2026';

test('the ledger splits on the boolean lesser served, not on the timestamps', () => {
	const active = grant({ grantee_username: 'editor' });
	const revoked = grant({
		grantee_username: 'former',
		active: false,
		revoked_at: '2026-04-02T00:00:00Z',
		revoked_by: 'owner',
	});

	const ledger = accessLedger([active, revoked]);

	assert.deepEqual(ledger.current, [active], 'active entries are who holds access now');
	assert.deepEqual(ledger.revoked, [revoked], 'and revoked entries are the audit half');
	assert.deepEqual(ledger.unreadable, [], 'a conforming answer leaves nothing unclassified');
});

test('an entry lesser did not classify is placed on neither side', () => {
	// BOTH defaults are a false statement to the owner: filed under `current` it
	// claims access the instance never confirmed, filed under `revoked` it tells
	// an owner someone's access is gone when it may not be. So the third bucket
	// is the assertion, and it is asserted for every non-boolean lesser could
	// put in the field — including `'true'`, which a truthiness check would have
	// read as access.
	for (const active of [undefined, null, 'true', 'false', 1, 0, {}]) {
		const entry = grant({ active });
		const ledger = accessLedger([entry]);

		assert.deepEqual(ledger.current, [], `${JSON.stringify(active)} is not a claim of access`);
		assert.deepEqual(ledger.revoked, [], 'nor a claim that access was taken away');
		assert.deepEqual(ledger.unreadable, [entry], 'it is counted, and the panel says so');
	}
});

test("the ledger keeps lesser's order within each side", () => {
	// Re-sorting by `revoked_at` would order the list by a field that is
	// optional in the contract, which is an ordering claim built on a value that
	// is not always there. lesser returns the rows sorted by grantee; that order
	// survives the split.
	const grants = [
		grant({ grantee_username: 'ada' }),
		grant({ grantee_username: 'bob', active: false, revoked_at: '2026-04-01T00:00:00Z' }),
		grant({ grantee_username: 'cyd' }),
		grant({ grantee_username: 'dee', active: false, revoked_at: '2026-02-01T00:00:00Z' }),
	];

	const ledger = accessLedger(grants);

	assert.deepEqual(
		ledger.current.map((entry) => entry.grantee_username),
		['ada', 'cyd']
	);
	assert.deepEqual(
		ledger.revoked.map((entry) => entry.grantee_username),
		// 'bob' before 'dee' — served order, NOT most-recently-revoked first.
		['bob', 'dee']
	);
});

test('an empty answer is an empty ledger rather than an absent one', () => {
	const ledger = accessLedger([]);
	assert.deepEqual(ledger, { current: [], revoked: [], unreadable: [] });
});

test('a stamp names when and who when lesser served both', () => {
	assert.equal(
		grantStamp('granted', '2026-03-01T00:00:00Z', 'owner', fixed),
		'granted 1 Mar 2026 by @owner'
	);
	assert.equal(
		grantStamp('revoked', '2026-03-01T00:00:00Z', 'admin', fixed),
		'revoked 1 Mar 2026 by @admin'
	);
});

test('a stamp drops the clause lesser did not serve rather than filling it', () => {
	// `revoked_by` is optional in the contract and `revoked_at` is nullable. A
	// filled blank — "by unknown", "revoked recently", the owner's own name —
	// would be this client inventing the answer to the question the owner
	// opened the screen to ask.
	assert.equal(
		grantStamp('revoked', '2026-03-01T00:00:00Z', undefined, fixed),
		'revoked 1 Mar 2026'
	);
	assert.equal(grantStamp('revoked', '2026-03-01T00:00:00Z', '   ', fixed), 'revoked 1 Mar 2026');
	assert.equal(grantStamp('revoked', null, 'admin', fixed), 'revoked by @admin');
	assert.equal(grantStamp('revoked', 'not a date', 'admin', fixed), 'revoked by @admin');
	assert.equal(grantStamp('revoked', 1_772_000_000_000, 'admin', fixed), 'revoked by @admin');

	// Neither served: the verb alone, which is `active`'s own content and so
	// still true. Never an empty string, and never a stamp that reads as if the
	// instance had answered.
	assert.equal(grantStamp('revoked', null, null, fixed), 'revoked');
	assert.equal(grantStamp('granted', undefined, undefined, fixed), 'granted');
});

test('the stamp formats through the caller’s formatter, not a fixed locale', () => {
	// The panel passes the reader's locale; this asserts the seam exists at all,
	// so the probes above are testing composition rather than the host's ICU
	// data. The default is exercised separately below.
	const seen = [];
	grantStamp('granted', '2026-03-01T00:00:00Z', 'owner', (moment) => {
		seen.push(moment);
		return 'FORMATTED';
	});

	assert.equal(seen.length, 1, 'the served timestamp reaches the formatter');
	assert.ok(seen[0] instanceof Date, 'as a Date, parsed once');
	assert.equal(seen[0].toISOString(), '2026-03-01T00:00:00.000Z');
});

test('the default format is a date for a reader, not a machine timestamp', () => {
	const served = '2026-03-01T09:41:07Z';
	const stamped = grantStamp('granted', served, 'owner');

	// THE BOUND OF THIS ASSERTION, stated because the first line computes the
	// expectation the same way the module does and so cannot catch a change
	// BETWEEN locale renderings. What it does catch is the failure that
	// actually happens: the served string reaching the screen unformatted, or
	// an ISO/epoch rendering standing in for a date an owner reads.
	assert.equal(stamped, `granted ${new Date(served).toLocaleDateString()} by @owner`);
	assert.ok(!stamped.includes(served), 'the raw served timestamp is not what is shown');
	assert.ok(!stamped.includes('T09:41'), 'nor any machine rendering of the clock time');
});
