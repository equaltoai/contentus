/**
 * What the owner may be told about who has been driving an agent (M2.4,
 * equaltoai/contentus#95).
 *
 * These probes drive `activity-view.ts` directly, the way
 * `agent-share-view.test.mjs` drives its neighbour, because every claim this
 * milestone makes on screen is composed there. The ones worth having are the
 * ones that bite on a FALSE SENTENCE rather than a wrong shape: an empty roster
 * that says nobody has driven the agent, a driver counted from a row that named
 * nobody, an identity printed as `@@ada`. A test that only checks the happy
 * fold would stay green through all three.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	actionDrivers,
	driverLabel,
	driverLedger,
	driverStamp,
	mechanismLabel,
	noDriverStatement,
	partialAttributionNotice,
	toAgentAction,
} from '../src/lib/agents/activity-view.ts';

const FIXED = (moment) => moment.toISOString().slice(0, 10);

function node(overrides = {}) {
	return {
		eventId: 'evt-1',
		agentUsername: 'scribe',
		action: 'agent.status.create',
		targetId: null,
		metadataJson: JSON.stringify({ delegated_by: '@ada' }),
		timestamp: '2026-08-10T12:00:00Z',
		...overrides,
	};
}

/* -------------------------------------------------------------------------
 * The identity, and the two spellings lesser writes it in
 * ---------------------------------------------------------------------- */

test('a bare username gets the sigil and a normalized one does not get a second', () => {
	// `acted_by` is bare (ActAsResolution.ActedBy); `delegated_by` has been
	// through normalizeDelegatedBy, which prepends `@`. Rendering `@{value}`
	// over both is what this function exists to stop.
	assert.equal(driverLabel('ada'), '@ada');
	assert.equal(driverLabel('@ada'), '@ada');
	assert.equal(driverLabel('  @ada  '), '@ada');
});

test('an owner stored in actor-URL form is shown as the URL, not as @https://…', () => {
	// normalizeDelegatedBy prepends to a URL too, so this is a value lesser
	// really stores (pkg/auth/agent_owner.go:5-9).
	assert.equal(
		driverLabel('@https://instance.example/users/ada'),
		'https://instance.example/users/ada'
	);
	assert.equal(
		driverLabel('https://instance.example/users/ada'),
		'https://instance.example/users/ada'
	);
});

test('nothing usable is null rather than a bare sigil', () => {
	assert.equal(driverLabel(''), null);
	assert.equal(driverLabel('   '), null);
	assert.equal(driverLabel('@'), null);
	assert.equal(driverLabel(null), null);
	assert.equal(driverLabel(42), null);
});

/* -------------------------------------------------------------------------
 * Reading the metadata, and the three answers it can give
 * ---------------------------------------------------------------------- */

test('delegated_by is the MCP driver and acted_by is the act-as one', () => {
	assert.deepEqual(actionDrivers(JSON.stringify({ delegated_by: '@ada' })), {
		drivers: [{ label: '@ada', mechanism: 'mcp' }],
		attribution: 'named',
	});
	assert.deepEqual(actionDrivers(JSON.stringify({ acted_by: 'bob' })), {
		drivers: [{ label: '@bob', mechanism: 'act-as' }],
		attribution: 'named',
	});
});

test('a row carrying both keys keeps both, MCP first', () => {
	// lesser's statuses.go passes ONE metadata map to both writers in sequence,
	// so the act-as row is marshalled with delegated_by already in it. Choosing
	// one would drop a real person from an owner's view of who drove the agent.
	const { drivers, attribution } = actionDrivers(
		JSON.stringify({ delegated_by: '@ada', acted_by: 'bob' })
	);
	assert.equal(attribution, 'named');
	assert.deepEqual(drivers, [
		{ label: '@ada', mechanism: 'mcp' },
		{ label: '@bob', mechanism: 'act-as' },
	]);
});

test('metadata that will not parse is unreadable, not driverless', () => {
	// The resolver hands the stored column back without parsing it
	// (agentActivityMetadataPtr), so this is a state the contract permits.
	assert.deepEqual(actionDrivers('{not json'), { drivers: [], attribution: 'unreadable' });
	assert.deepEqual(actionDrivers('"a string"'), { drivers: [], attribution: 'unreadable' });
	assert.deepEqual(actionDrivers('[1,2]'), { drivers: [], attribution: 'unreadable' });
	assert.deepEqual(actionDrivers('null'), { drivers: [], attribution: 'unreadable' });
});

test('absent metadata is an action that named nobody, which is a different fact', () => {
	assert.deepEqual(actionDrivers(null), { drivers: [], attribution: 'unnamed' });
	assert.deepEqual(actionDrivers(undefined), { drivers: [], attribution: 'unnamed' });
	assert.deepEqual(actionDrivers(''), { drivers: [], attribution: 'unnamed' });
	assert.deepEqual(actionDrivers(JSON.stringify({ target_id: 'x' })), {
		drivers: [],
		attribution: 'unnamed',
	});
});

test('an empty attribution value does not count as a driver', () => {
	assert.deepEqual(actionDrivers(JSON.stringify({ delegated_by: '   ' })), {
		drivers: [],
		attribution: 'unnamed',
	});
});

/* -------------------------------------------------------------------------
 * One row
 * ---------------------------------------------------------------------- */

test('a node missing a contract-non-null field yields nothing rather than a blank row', () => {
	assert.equal(toAgentAction(node({ eventId: '' })), null);
	assert.equal(toAgentAction(node({ action: '   ' })), null);
	assert.equal(toAgentAction(null), null);
	assert.equal(toAgentAction('agent.status.create'), null);
	assert.equal(toAgentAction([]), null);
});

test('an unreadable timestamp becomes null instead of a fabricated moment', () => {
	assert.equal(toAgentAction(node({ timestamp: 'not a date' })).at, null);
	assert.equal(toAgentAction(node({ timestamp: null })).at, null);
});

test('the event token is carried verbatim', () => {
	const parsed = toAgentAction(node({ action: 'agent.share.revoke' }));
	assert.equal(parsed.action, 'agent.share.revoke');
});

/* -------------------------------------------------------------------------
 * The fold
 * ---------------------------------------------------------------------- */

test('drivers are folded with counts and keep lesser newest-first order', () => {
	const ledger = driverLedger([
		node({
			eventId: 'e1',
			timestamp: '2026-08-10T12:00:00Z',
			metadataJson: JSON.stringify({ delegated_by: '@bob' }),
		}),
		node({
			eventId: 'e2',
			timestamp: '2026-08-09T12:00:00Z',
			metadataJson: JSON.stringify({ delegated_by: '@ada' }),
		}),
		node({
			eventId: 'e3',
			timestamp: '2026-08-08T12:00:00Z',
			metadataJson: JSON.stringify({ delegated_by: '@ada' }),
		}),
	]);

	// Encounter order IS recency order — the resolver sorts newest-first before
	// paginating — so @bob leads without this module sorting on a field it has
	// already established may be absent.
	assert.deepEqual(
		ledger.drivers.map((driver) => [driver.label, driver.actions]),
		[
			['@bob', 1],
			['@ada', 2],
		]
	);
	assert.equal(ledger.drivers[1].latest.toISOString(), '2026-08-09T12:00:00.000Z');
	assert.equal(ledger.unnamed, 0);
	assert.equal(ledger.unreadable, 0);
	assert.equal(ledger.more, false);
});

test("a driver's latest survives a leading row whose timestamp did not parse", () => {
	const ledger = driverLedger([
		node({
			eventId: 'e1',
			timestamp: 'not a date',
			metadataJson: JSON.stringify({ delegated_by: '@ada' }),
		}),
		node({
			eventId: 'e2',
			timestamp: '2026-08-09T12:00:00Z',
			metadataJson: JSON.stringify({ delegated_by: '@ada' }),
		}),
	]);
	assert.equal(ledger.drivers[0].actions, 2);
	assert.equal(ledger.drivers[0].latest.toISOString(), '2026-08-09T12:00:00.000Z');
});

test('a driver named through both mechanisms records both, once each', () => {
	const ledger = driverLedger([
		node({ eventId: 'e1', metadataJson: JSON.stringify({ delegated_by: '@ada' }) }),
		node({ eventId: 'e2', metadataJson: JSON.stringify({ acted_by: 'ada' }) }),
		node({ eventId: 'e3', metadataJson: JSON.stringify({ acted_by: 'ada' }) }),
	]);
	assert.deepEqual(ledger.drivers[0].mechanisms, ['mcp', 'act-as']);
	assert.equal(ledger.drivers[0].actions, 3);
});

test('unnamed and unreadable rows are counted apart and neither becomes a driver', () => {
	const ledger = driverLedger([
		node({ eventId: 'e1', metadataJson: JSON.stringify({ delegated_by: '@ada' }) }),
		node({ eventId: 'e2', metadataJson: null }),
		node({ eventId: 'e3', metadataJson: '{broken' }),
	]);
	assert.equal(ledger.drivers.length, 1);
	assert.equal(ledger.unnamed, 1);
	assert.equal(ledger.unreadable, 1);
	assert.equal(ledger.actions.length, 3);
});

test('unreadable nodes are dropped from the action list without taking the fold down', () => {
	const ledger = driverLedger([node({ eventId: '' }), undefined, node({ eventId: 'e2' })]);
	assert.equal(ledger.actions.length, 1);
	assert.equal(ledger.actions[0].eventId, 'e2');
});

/* -------------------------------------------------------------------------
 * What an empty roster may claim — the M2.3 lesson, on this surface
 * ---------------------------------------------------------------------- */

test('nobody-has-driven-it is only said when lesser recorded nothing at all', () => {
	const empty = driverLedger([]);
	assert.equal(
		noDriverStatement('scribe', empty),
		'This instance has recorded no actions for @scribe in the activity it keeps.'
	);
});

test('actions that named nobody never become a statement that nobody drove the agent', () => {
	const ledger = driverLedger([
		node({ metadataJson: null }),
		node({ eventId: 'e2', metadataJson: null }),
	]);
	const statement = noDriverStatement('scribe', ledger);
	assert.equal(
		statement,
		'This instance recorded 2 actions for @scribe without naming who drove them.'
	);
	// The bite: the certain sentence must not appear, in any form.
	assert.ok(!statement.includes('no actions'));
	assert.ok(!/nobody/i.test(statement));
});

test('unreadable rows force the statement to disclaim itself', () => {
	const ledger = driverLedger([node({ metadataJson: '{broken' })]);
	const statement = noDriverStatement('scribe', ledger);
	assert.ok(statement.includes('could not be read'));
	assert.ok(statement.includes('not a statement that nobody has driven it'));
});

test('a roster that exists suppresses the empty statement entirely', () => {
	assert.equal(noDriverStatement('scribe', driverLedger([node()])), null);
});

/* -------------------------------------------------------------------------
 * What qualifies a roster that is not empty
 * ---------------------------------------------------------------------- */

test('a roster with unattributed rows beside it says it is not everyone', () => {
	const ledger = driverLedger([node(), node({ eventId: 'e2', metadataJson: null })]);
	const notice = partialAttributionNotice(ledger);
	assert.equal(
		notice,
		'Of the actions below, one names no driver, so this list is not everyone who has driven this agent.'
	);
});

test('both kinds of gap are named in one sentence', () => {
	const ledger = driverLedger([
		node(),
		node({ eventId: 'e2', metadataJson: null }),
		node({ eventId: 'e3', metadataJson: null }),
		node({ eventId: 'e4', metadataJson: '{broken' }),
	]);
	assert.equal(
		partialAttributionNotice(ledger),
		'Of the actions below, 2 name no driver and one has details that could not be read, so this list is not everyone who has driven this agent.'
	);
});

test('a fully attributed roster is not qualified, and an empty one is left to the other sentence', () => {
	assert.equal(partialAttributionNotice(driverLedger([node()])), null);
	assert.equal(partialAttributionNotice(driverLedger([node({ metadataJson: null })])), null);
});

/* -------------------------------------------------------------------------
 * The line under a driver's name
 * ---------------------------------------------------------------------- */

test('the stamp drops the recency clause rather than inventing a moment', () => {
	const withTime = driverLedger([node()]).drivers[0];
	assert.equal(driverStamp(withTime, FIXED), '1 action, most recently 2026-08-10');

	const withoutTime = driverLedger([node({ timestamp: 'not a date' })]).drivers[0];
	assert.equal(driverStamp(withoutTime, FIXED), '1 action');
});

test('the count is pluralized rather than assembled around a bare number', () => {
	const two = driverLedger([node(), node({ eventId: 'e2' })]).drivers[0];
	assert.equal(driverStamp(two, FIXED), '2 actions, most recently 2026-08-10');
});

test('the mechanism is said in the owner terms, not the metadata key name', () => {
	assert.equal(mechanismLabel('mcp'), "signed in to the agent's MCP");
	assert.equal(mechanismLabel('act-as'), 'acted as the agent in a CMS client');
});

/* -------------------------------------------------------------------------
 * The boundary of one read
 * ---------------------------------------------------------------------- */

test('more is lessers word and defaults to false rather than to a claim', () => {
	assert.equal(driverLedger([node()]).more, false);
	assert.equal(driverLedger([node()], { more: true }).more, true);
	assert.equal(driverLedger([node()], { more: 'yes' }).more, false);
});
