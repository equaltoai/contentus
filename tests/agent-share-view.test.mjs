import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	accessLedger,
	grantStamp,
	noCurrentAccessStatement,
	noSharedAgentsStatement,
	unclassifiedEntriesNotice,
	unlistedSharesNotice,
} from '../src/lib/agents/share-view.ts';

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

/* -------------------------------------------------------------------------
 * What the panel SAYS about the classification
 *
 * The split above decides which list a row lands in. These decide the two
 * sentences that speak for the rows that landed in NEITHER — the counting
 * notice, and the empty state of the current-access list. Both are copy, so no
 * probe over the component tree catches a rewrite of them; they are composed in
 * `share-view.ts` precisely so they can be called here.
 * ---------------------------------------------------------------------- */

/** A ledger with `count` entries lesser did not classify. */
function ledgerWithUnreadable(count, rest = {}) {
	return accessLedger([
		...(rest.current ?? []),
		...(rest.revoked ?? []),
		...Array.from({ length: count }, (_, index) =>
			grant({ active: undefined, grantee_username: `unmarked${index}` })
		),
	]);
}

test('the unclassified notice counts the entries lesser did not classify', () => {
	assert.equal(
		unclassifiedEntriesNotice(accessLedger([grant(), grant({ active: false })])),
		null,
		'a conforming answer says nothing, rather than saying zero'
	);

	const one = unclassifiedEntriesNotice(ledgerWithUnreadable(1));
	assert.match(one, /one share entry/, 'one entry is a sentence, not a numeral');
	assert.doesNotMatch(one, /\d/, 'and carries no digit at all');

	// The count is of UNREADABLE entries, not of the answer: a notice that
	// counted the whole list would tell an owner with three good grants and one
	// unmarked row that the instance failed to classify four.
	const three = unclassifiedEntriesNotice(
		ledgerWithUnreadable(3, { current: [grant(), grant()], revoked: [grant({ active: false })] })
	);
	assert.match(three, /\b3 share entries\b/, 'and the plural counts only the unclassified rows');
});

test('the empty state states nobody holds access only when nothing was unclassified', () => {
	assert.equal(
		noCurrentAccessStatement('scribe', accessLedger([grant({ active: false })])),
		'No account holds access to @scribe right now.',
		'with every entry classified, an empty current list IS the instance’s answer'
	);
});

test('the empty state does not claim nobody holds access while entries were unreadable', () => {
	// THE FAILURE THIS HOLDS SHUT (equaltoai/contentus#100, codex review
	// 4941340448): a 200 that drops `active` from a live grantee's row hides that
	// row from both lists, and an empty state that still reads "no account holds
	// access to @scribe" then tells the owner the OPPOSITE of the only claim that
	// survives the malformed answer. The unclassified rows are exactly the ones
	// that might be live grants, so this is the case where certainty is least
	// available and most damaging.
	const certain = noCurrentAccessStatement('scribe', accessLedger([]));

	for (const count of [1, 2, 7]) {
		const statement = noCurrentAccessStatement('scribe', ledgerWithUnreadable(count));

		assert.notEqual(statement, certain, `${count} unclassified entries must change the claim`);
		// A CAVEAT BOLTED ONTO A FALSE SENTENCE IS STILL THE FALSE SENTENCE, and is
		// the likeliest shape of a careless fix — so the assertion is that the
		// certain claim does not appear at all, not merely that something was
		// appended after it.
		assert.ok(
			!statement.includes('No account holds access'),
			`the certain claim must not survive as a clause: ${statement}`
		);
		assert.match(
			statement,
			/could not be determined/i,
			'the empty state must say the access it could not determine'
		);
		assert.match(
			statement,
			count === 1 ? /\bone further entry\b/ : new RegExp(`\\b${count} further entries\\b`),
			'and say how many entries it could not determine it for'
		);
		assert.match(statement, /@scribe/, 'while still naming the agent it is speaking about');
	}
});

test('the empty state is a statement about classification, not about the revoked list', () => {
	// Revoked entries are classified, so they neither soften nor harden the
	// claim: an owner whose only grantee was revoked is told plainly that nobody
	// holds access, and one with an unmarked row is not told that regardless of
	// how much revoked history sits beside it.
	const revokedOnly = accessLedger([grant({ active: false }), grant({ active: false })]);
	assert.equal(
		noCurrentAccessStatement('scribe', revokedOnly),
		'No account holds access to @scribe right now.'
	);

	const withHistory = ledgerWithUnreadable(1, { revoked: [grant({ active: false })] });
	assert.ok(!noCurrentAccessStatement('scribe', withHistory).includes('No account holds access'));
});

/* -------------------------------------------------------------------------
 * The grantee's half — what the shared-with-me panel may say
 *
 * THE SAME CLASSIFIER, A DIFFERENT SUBJECT, AND THEREFORE DIFFERENT SENTENCES.
 * The panel had `grants.filter((g) => g.active)` — truthiness, not `=== true` —
 * over a list it renders with a certain empty state, so a row lesser sent
 * without the boolean was dropped from the list and then denied by the sentence
 * underneath it. Both halves of that are asserted below.
 *
 * WHAT THIS IS NOT EVIDENCE OF: a live outage. lesser answers
 * `/api/v1/agents/shared-with-me` from the grantee index with
 * `Filter("RevokedAt", "attribute_not_exists", nil)`
 * (`pkg/storage/repositories/agent_share_repository.go:169`), and serializes
 * `active` as `RevokedAt == nil` on a field with no `omitempty`
 * (`cmd/api/handlers/agent_shares.go:176`,
 * `cmd/api/models/agent_shares.go:13`), so a conforming instance sends `true`
 * on every row of this list. The unclassified case is reachable only from a
 * non-conforming answer — which is exactly the answer a client must not turn
 * into a confident claim, and the reason the probes are worth their lines.
 * ---------------------------------------------------------------------- */

test('the grantee notice counts the entries lesser did not classify', () => {
	assert.equal(
		unlistedSharesNotice(accessLedger([grant(), grant({ active: false })])),
		null,
		'a conforming answer says nothing, rather than saying zero'
	);

	const one = unlistedSharesNotice(ledgerWithUnreadable(1));
	assert.match(one, /one share entry/, 'one entry is a sentence, not a numeral');
	assert.doesNotMatch(one, /\d/, 'and carries no digit at all');

	const three = unlistedSharesNotice(
		ledgerWithUnreadable(3, { current: [grant(), grant()], revoked: [grant({ active: false })] })
	);
	assert.match(three, /\b3 share entries\b/, 'and the plural counts only the unclassified rows');

	// NOT THE OWNER'S NOTICE. That one sends the reader to "neither list below",
	// which is a true description of a screen with two lists and a wild goose
	// chase on this one, where the grantee sees a single list of agents.
	for (const notice of [one, three]) {
		assert.doesNotMatch(
			notice,
			/neither list/i,
			'the grantee panel has one list; the owner panel’s wording must not be reused verbatim here'
		);
		assert.match(notice, /not listed below/i, 'it says where the row went: nowhere they can see');
	}
});

test('a grantee with agents shared with them is told plainly when nothing was hidden', () => {
	// The certain sentence is the shipped one, and it stays the answer for every
	// classified response — including one where every row came back revoked,
	// because a classified row is an answered row and the grantee index would not
	// have carried it in the first place.
	assert.equal(
		noSharedAgentsStatement(accessLedger([])),
		'No agents have been shared with you.',
		'an empty classified answer IS the instance’s statement'
	);
	assert.equal(
		noSharedAgentsStatement(accessLedger([grant({ active: false })])),
		'No agents have been shared with you.',
		'and a fully classified list with nothing active is the same statement'
	);
});

test('the grantee empty state does not deny a share while entries were unreadable', () => {
	// THE DEFECT THIS CLOSES: the panel filtered on truthiness and then rendered
	// "No agents have been shared with you." A 200 that dropped `active` from a
	// real grantee's row therefore hid the row AND told the reader the opposite
	// of the only claim that survives the malformed answer — the same failure the
	// owner panel closed at equaltoai/contentus#100, on the other side of the
	// same contract.
	const certain = noSharedAgentsStatement(accessLedger([]));

	for (const count of [1, 2, 7]) {
		const statement = noSharedAgentsStatement(ledgerWithUnreadable(count));

		assert.notEqual(statement, certain, `${count} unclassified entries must change the claim`);
		// A CAVEAT BOLTED ONTO A FALSE SENTENCE IS STILL THE FALSE SENTENCE, and is
		// the likeliest shape of a careless fix — so the assertion is that the
		// certain claim does not appear at all, not merely that something follows it.
		assert.ok(
			!statement.includes('No agents have been shared with you'),
			`the certain claim must not survive as a clause: ${statement}`
		);
		assert.match(
			statement,
			/could not be read/i,
			'the empty state must say there were entries it could not read'
		);
		assert.match(
			statement,
			count === 1 ? /\bOne further entry\b/ : new RegExp(`\\b${count} further entries\\b`),
			'and say how many'
		);
	}
});

test('the grantee empty state speaks about shares, never about who holds access', () => {
	// The two panels read different routes with different authorization, and the
	// owner's sentence names an agent (`@scribe`) whose access is being reported
	// on. Spoken on the grantee's screen it would be a claim about a stranger's
	// agent — and it is the sentence closest to hand, one import away in the same
	// module.
	for (const ledger of [accessLedger([]), ledgerWithUnreadable(1), ledgerWithUnreadable(4)]) {
		const statement = noSharedAgentsStatement(ledger);
		assert.doesNotMatch(
			statement,
			/holds access/i,
			'the grantee is told what was shared with them, not who holds access to an agent'
		);
		assert.doesNotMatch(statement, /@/, 'and no agent is named: this list is about all of them');
	}
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
