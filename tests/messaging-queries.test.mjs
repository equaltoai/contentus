/**
 * Contentus's messaging documents, pinned against greater's generated ones.
 *
 * WHY THIS PROBE IS THE LOAD-BEARING ONE. `$lib/messaging/queries` hand-authors
 * every document face 5 sends, because importing greater's generated module
 * from owned source drags `@apollo/client`, `graphql` and
 * `@graphql-typed-document-node/core` into contentus's typecheck graph —
 * packages this client refuses to install (see `$lib/messaging/handlers`). Hand
 * authoring is only safe if something notices when upstream moves. This is that
 * something.
 *
 * A probe may import the vendored module freely: `node --test` resolves at
 * runtime and is outside the typecheck graph entirely. So this file reads the
 * REAL generated ASTs, prints them, and asserts that contentus asks lesser for
 * the same operations with the same arguments — and that every field the
 * mappers in `$lib/messaging/contract` read is actually selected.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. Not string equality: contentus selects
 * NARROWER field sets on purpose (greater's `ObjectFields` carries poll state,
 * quote context and community notes no messaging component reads). Asserting
 * equality would fail on a difference that is the point. What must match is the
 * CONTRACT SURFACE — operation type, root field, argument names, variable types
 * — because those are lesser's and getting one wrong is a runtime error on
 * somebody's instance.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { printDocument } from './helpers/print-graphql.mjs';
import * as queries from '../src/lib/messaging/queries.ts';

const GENERATED = readFileSync('src/lib/greater/adapters/graphql/generated/types.ts', 'utf8');

/** Pull one document AST out of the vendored generated module. */
function vendoredDocument(name) {
	const match = GENERATED.match(new RegExp(`export const ${name} = (\\{.*?\\}) as unknown`, 's'));
	assert.ok(match, `vendored document ${name} not found — the pin moved or the name changed`);
	return JSON.parse(match[1]);
}

/** `{ operation, rootField, args, variables }` for a vendored document. */
function vendoredSurface(name) {
	const document = vendoredDocument(name);
	const op = document.definitions.find((d) => d.kind === 'OperationDefinition');
	assert.ok(op, `${name} has no operation definition`);

	const root = op.selectionSet.selections.find((s) => s.kind === 'Field');
	assert.ok(root, `${name} has no root field`);

	const variables = {};
	for (const def of op.variableDefinitions ?? []) {
		// Printed rather than reconstructed, so `[ID!]` and `ID!` are compared as
		// the strings the server will see.
		variables[def.variable.name.value] = printDocument({
			kind: 'Document',
			definitions: [
				{
					kind: 'OperationDefinition',
					operation: 'query',
					variableDefinitions: [def],
					selectionSet: {
						kind: 'SelectionSet',
						selections: [{ kind: 'Field', name: { kind: 'Name', value: 'x' } }],
					},
				},
			],
		})
			.match(/\$[A-Za-z0-9_]+: ([^),=]+)/)[1]
			.trim();
	}

	return {
		operation: op.operation,
		rootField: root.name.value,
		args: (root.arguments ?? []).map((a) => a.name.value).sort(),
		variables,
	};
}

/**
 * The contentus document, reduced to the same surface.
 *
 * Parsed with narrow regexes rather than a full parser: these documents are
 * authored in this repo and their shape is known, and a second parser would be
 * a second thing to get wrong.
 */
function contentusSurface(document) {
	const header = document.match(
		/(query|mutation|subscription)\s+\w+\s*(\(([^)]*)\))?\s*\{\s*(\w+)\s*(\(([^)]*)\))?/
	);
	assert.ok(header, `could not read the operation header from:\n${document.slice(0, 200)}`);

	const variables = {};
	for (const part of (header[3] ?? '').split(',')) {
		const variable = part.match(/\$(\w+)\s*:\s*([^,]+)/);
		if (variable) variables[variable[1]] = variable[2].trim();
	}

	return {
		operation: header[1],
		rootField: header[4],
		args: (header[6] ?? '')
			.split(',')
			.map((part) => part.split(':')[0].trim())
			.filter(Boolean)
			.sort(),
		variables,
	};
}

/**
 * Every operation contentus sends, and the vendored document it mirrors.
 *
 * `sentArgs` is what contentus actually passes. It is smaller than upstream's
 * where contentus deliberately omits an argument — `conversations.after` is the
 * example, and the omission is the finding: lesser accepts a cursor there and
 * returns no cursor anywhere, so no client can supply one.
 */
const OPERATIONS = [
	{
		label: 'conversations',
		document: queries.CONVERSATIONS_QUERY,
		vendored: 'ConversationsDocument',
		sentArgs: ['first', 'folder'],
	},
	{
		label: 'conversation',
		document: queries.CONVERSATION_QUERY,
		vendored: 'ConversationDocument',
		sentArgs: ['id'],
	},
	{
		label: 'conversationMessages',
		document: queries.CONVERSATION_MESSAGES_QUERY,
		vendored: 'ConversationMessagesDocument',
		sentArgs: ['after', 'conversationId', 'first'],
	},
	{
		label: 'sendMessage',
		document: queries.SEND_MESSAGE_MUTATION,
		vendored: 'SendMessageDocument',
		sentArgs: ['content', 'conversationId', 'mediaIds'],
	},
	{
		label: 'createConversation',
		document: queries.CREATE_CONVERSATION_MUTATION,
		vendored: 'CreateConversationDocument',
		sentArgs: ['participantId'],
	},
	{
		label: 'acceptMessageRequest',
		document: queries.ACCEPT_MESSAGE_REQUEST_MUTATION,
		vendored: 'AcceptMessageRequestDocument',
		sentArgs: ['conversationId'],
	},
	{
		label: 'declineMessageRequest',
		document: queries.DECLINE_MESSAGE_REQUEST_MUTATION,
		vendored: 'DeclineMessageRequestDocument',
		sentArgs: ['conversationId'],
	},
	{
		label: 'deleteConversation',
		document: queries.DELETE_CONVERSATION_MUTATION,
		vendored: 'DeleteConversationDocument',
		sentArgs: ['conversationId'],
	},
	{
		label: 'deleteMessage',
		document: queries.DELETE_MESSAGE_MUTATION,
		vendored: 'DeleteMessageDocument',
		sentArgs: ['messageId'],
	},
	{
		label: 'markConversationAsRead',
		document: queries.MARK_CONVERSATION_READ_MUTATION,
		vendored: 'MarkConversationReadDocument',
		sentArgs: ['id'],
	},
	{
		label: 'search',
		document: queries.SEARCH_ACTORS_QUERY,
		vendored: 'SearchDocument',
		sentArgs: ['first', 'query', 'type'],
	},
	{
		label: 'conversationUpdates',
		document: queries.CONVERSATION_UPDATES_SUBSCRIPTION,
		vendored: 'ConversationUpdatesDocument',
		sentArgs: [],
	},
];

test('every contentus messaging document targets upstream operation and root field', () => {
	for (const entry of OPERATIONS) {
		const mine = contentusSurface(entry.document);
		const theirs = vendoredSurface(entry.vendored);

		assert.equal(
			mine.operation,
			theirs.operation,
			`${entry.label}: contentus sends a ${mine.operation} where lesser defines a ${theirs.operation}`
		);
		assert.equal(
			mine.rootField,
			theirs.rootField,
			`${entry.label}: root field drifted from ${theirs.rootField} to ${mine.rootField}`
		);
	}
});

test('every argument contentus sends exists on the upstream operation', () => {
	for (const entry of OPERATIONS) {
		const mine = contentusSurface(entry.document);
		const theirs = vendoredSurface(entry.vendored);

		assert.deepEqual(
			mine.args,
			entry.sentArgs,
			`${entry.label}: the document sends ${JSON.stringify(mine.args)}, the table expects ${JSON.stringify(entry.sentArgs)}`
		);

		for (const arg of mine.args) {
			assert.ok(
				theirs.args.includes(arg),
				`${entry.label}: sends "${arg}", which is not an argument of lesser's ${theirs.rootField}`
			);
		}
	}
});

test('every variable contentus declares has upstream’s type', () => {
	for (const entry of OPERATIONS) {
		const mine = contentusSurface(entry.document);
		const theirs = vendoredSurface(entry.vendored);

		for (const [name, type] of Object.entries(mine.variables)) {
			assert.ok(
				name in theirs.variables,
				`${entry.label}: declares $${name}, which upstream's operation does not have`
			);
			assert.equal(
				type,
				theirs.variables[name],
				`${entry.label}: $${name} is ${type} here and ${theirs.variables[name]} upstream — a nullability or list mismatch lesser will reject`
			);
		}
	}
});

/**
 * The fields the mappers read, per document.
 *
 * This is the half that a contract comparison alone would miss: an operation
 * can be correct and still not select the field a mapper dereferences, and the
 * symptom is a blank display name rather than an error.
 */
const REQUIRED_FIELDS = [
	{
		label: 'conversations',
		document: queries.CONVERSATIONS_QUERY,
		fields: [
			'id',
			'unread',
			'updatedAt',
			'viewerMetadata',
			'requestState',
			'requestedAt',
			'acceptedAt',
			'declinedAt',
			'accounts',
			'lastStatus',
			'username',
			'domain',
			'displayName',
			'avatar',
			'content',
			'createdAt',
			'sensitive',
			'spoilerText',
		],
	},
	{
		label: 'conversationMessages',
		document: queries.CONVERSATION_MESSAGES_QUERY,
		// The cursor half is what makes #34's pagination possible at all: greater's
		// own handler drops `pageInfo`, so a document without it would leave the
		// "load older" control with no cursor to advance.
		fields: ['edges', 'cursor', 'node', 'pageInfo', 'hasNextPage', 'endCursor', 'totalCount'],
	},
	{
		label: 'sendMessage',
		document: queries.SEND_MESSAGE_MUTATION,
		fields: ['message', 'conversation', 'content', 'createdAt', 'actor'],
	},
	{
		label: 'acceptMessageRequest',
		document: queries.ACCEPT_MESSAGE_REQUEST_MUTATION,
		// Accept MUST return the new request state. Without it the surface would
		// have to assume the accept worked and move the card itself — inferring
		// request state instead of reading it, which #33 rules out.
		fields: ['viewerMetadata', 'requestState'],
	},
];

test('each document selects every field the mappers dereference', () => {
	for (const entry of REQUIRED_FIELDS) {
		for (const field of entry.fields) {
			assert.match(
				entry.document,
				new RegExp(`\\b${field}\\b`),
				`${entry.label}: does not select "${field}", which the mappers read`
			);
		}
	}
});

test('the conversation list document sends no cursor, because lesser returns none', () => {
	// A pinned FINDING rather than a preference. `conversations` accepts
	// `after: Cursor` and its selection returns a bare list — no `pageInfo`, no
	// per-edge cursor — so there is no value a client could ever pass back. If a
	// future pin makes it a real connection, this assertion fails and the
	// "conversations cannot be paginated" note in the consumption doc comes down
	// with it.
	const vendored = printDocument(vendoredDocument('ConversationsDocument'));
	assert.ok(
		vendored.includes('after: $after'),
		'upstream stopped sending `after` on conversations — re-check the pagination note'
	);
	assert.ok(
		!/conversations\([^)]*\)\s*\{[^}]*pageInfo/s.test(vendored),
		'upstream `conversations` now returns pageInfo — it can be paginated, so contentus should'
	);
	assert.ok(
		!queries.CONVERSATIONS_QUERY.includes('$after'),
		'contentus sends a cursor lesser gives it no way to obtain'
	);
});

test('the subscription payload is still id-only', () => {
	// The shape that forces the re-read design in `handlers.ts`: every event is a
	// signal, not data. If lesser starts publishing the message, the re-read is
	// no longer necessary and this fails so the design can be revisited.
	const vendored = printDocument(vendoredDocument('ConversationUpdatesDocument'));
	const selected = vendored
		.match(/conversationUpdates\s*\{([^}]*)\}/s)[1]
		.trim()
		.split(/\s+/);
	assert.deepEqual(
		selected,
		['id'],
		'`conversationUpdates` now publishes more than an id — the re-read in handlers.ts may be redundant'
	);
});
