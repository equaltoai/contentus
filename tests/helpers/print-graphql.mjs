/**
 * Print a vendored GraphQL document AST to its query string. PROBE-ONLY.
 *
 * WHY IT LIVES UNDER `tests/`. Contentus authors its own messaging documents
 * (`$lib/messaging/queries`) rather than importing greater's generated ones,
 * because that module's type surface reaches `@apollo/client`, `graphql` and
 * `@graphql-typed-document-node/core` — packages contentus deliberately does
 * not install (see the header of `$lib/messaging/handlers`). Owned source
 * therefore cannot import the vendored documents at all.
 *
 * A PROBE can: `node --test` resolves modules at runtime and is outside the
 * typecheck graph entirely. So `tests/messaging-queries.test.mjs` prints the
 * vendored ASTs with this and asserts contentus's hand-authored documents ask
 * lesser for the same operations, with the same arguments and variable types,
 * over the same fields the mappers read. That turns "these were copied
 * correctly once" into a checked fact that fails on the next pin bump if
 * upstream renames an argument.
 *
 * IT THROWS ON ANYTHING IT DOES NOT KNOW, and that is the whole safety
 * argument. A printer that skipped an unrecognised node would emit a VALID
 * query asking for less than the document says, and the probe built on it
 * would compare against a document upstream never wrote. Every switch below is
 * exhaustive and ends in a throw.
 */

function isNode(value) {
	return typeof value === 'object' && value !== null && typeof value.kind === 'string';
}

function fail(what, node) {
	const kind = isNode(node) ? node.kind : typeof node;
	throw new Error(
		`Unsupported GraphQL ${what} node "${kind}". ` +
			'The vendored messaging documents introduced a construct $lib/messaging/document ' +
			'does not print. Extend the printer — never skip the node, which would silently ' +
			'ask lesser for a smaller document than the pinned operation selects.'
	);
}

function name(node) {
	if (!isNode(node) || node.kind !== 'Name' || typeof node.value !== 'string') {
		return fail('name', node);
	}
	return node.value;
}

/** A type reference: `Foo`, `Foo!`, `[Foo!]!`. */
function printType(node) {
	if (!isNode(node)) return fail('type', node);

	switch (node.kind) {
		case 'NamedType':
			return name(node.name);
		case 'NonNullType':
			return `${printType(node.type)}!`;
		case 'ListType':
			return `[${printType(node.type)}]`;
		default:
			return fail('type', node);
	}
}

/**
 * A literal or variable in argument position.
 *
 * `StringValue` is JSON-encoded rather than wrapped in bare quotes so a value
 * containing a quote or a newline cannot break out of the literal and change
 * the operation being sent.
 */
function printValue(node) {
	if (!isNode(node)) return fail('value', node);

	switch (node.kind) {
		case 'Variable':
			return `$${name(node.name)}`;
		case 'IntValue':
		case 'FloatValue':
		case 'BooleanValue':
			return String(node.value);
		case 'EnumValue':
			return String(node.value);
		case 'StringValue':
			return JSON.stringify(String(node.value));
		case 'NullValue':
			return 'null';
		case 'ListValue':
			return `[${node.values.map(printValue).join(', ')}]`;
		case 'ObjectValue':
			return `{${node.fields
				.map((field) => {
					if (!isNode(field) || field.kind !== 'ObjectField') return fail('object field', field);
					return `${name(field.name)}: ${printValue(field.value)}`;
				})
				.join(', ')}}`;
		default:
			return fail('value', node);
	}
}

function printArguments(node) {
	const args = node.arguments;
	if (args === undefined || (Array.isArray(args) && args.length === 0)) return '';
	if (!Array.isArray(args)) return fail('arguments', args);

	return `(${args
		.map((arg) => {
			if (!isNode(arg) || arg.kind !== 'Argument') return fail('argument', arg);
			return `${name(arg.name)}: ${printValue(arg.value)}`;
		})
		.join(', ')})`;
}

/**
 * Directives are REFUSED rather than dropped.
 *
 * `@include`/`@skip` change which fields come back, and `@defer` changes the
 * response shape entirely. Printing a document that carries one while ignoring
 * it would send lesser an operation that means something different from the one
 * upstream pinned, which is precisely the silent divergence this module exists
 * to prevent.
 */
function assertNoDirectives(node) {
	const directives = node.directives;
	if (Array.isArray(directives) && directives.length > 0) {
		fail('directive', directives[0]);
	}
}

function printSelectionSet(node, depth) {
	if (!isNode(node) || node.kind !== 'SelectionSet') return fail('selection set', node);
	const selections = node.selections;
	if (!Array.isArray(selections)) return fail('selections', selections);

	const pad = '  '.repeat(depth + 1);
	const lines = selections.map((selection) => {
		if (!isNode(selection)) return fail('selection', selection);
		assertNoDirectives(selection);

		switch (selection.kind) {
			case 'Field': {
				const alias = selection.alias ? `${name(selection.alias)}: ` : '';
				const head = `${pad}${alias}${name(selection.name)}${printArguments(selection)}`;
				return selection.selectionSet
					? `${head} ${printSelectionSet(selection.selectionSet, depth + 1)}`
					: head;
			}
			case 'FragmentSpread':
				return `${pad}...${name(selection.name)}`;
			case 'InlineFragment': {
				const condition = selection.typeCondition
					? ` on ${printType(selection.typeCondition)}`
					: '';
				return `${pad}...${condition} ${printSelectionSet(selection.selectionSet, depth + 1)}`;
			}
			default:
				return fail('selection', selection);
		}
	});

	return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
}

function printVariableDefinitions(node) {
	const defs = node.variableDefinitions;
	if (defs === undefined || (Array.isArray(defs) && defs.length === 0)) return '';
	if (!Array.isArray(defs)) return fail('variable definitions', defs);

	return `(${defs
		.map((def) => {
			if (!isNode(def) || def.kind !== 'VariableDefinition') return fail('variable definition', def);
			assertNoDirectives(def);
			const variable = printValue(def.variable);
			const type = printType(def.type);
			// A default value is part of the operation's meaning: dropping it turns
			// `$first: Int = 20` into an unbounded read.
			const defaultValue =
				def.defaultValue === undefined || def.defaultValue === null
					? ''
					: ` = ${printValue(def.defaultValue)}`;
			return `${variable}: ${type}${defaultValue}`;
		})
		.join(', ')})`;
}

function printDefinition(node) {
	if (!isNode(node)) return fail('definition', node);
	assertNoDirectives(node);

	switch (node.kind) {
		case 'OperationDefinition': {
			const operation = String(node.operation);
			if (operation !== 'query' && operation !== 'mutation' && operation !== 'subscription') {
				return fail('operation', node);
			}
			const opName = node.name ? ` ${name(node.name)}` : '';
			return `${operation}${opName}${printVariableDefinitions(node)} ${printSelectionSet(
				node.selectionSet,
				0
			)}`;
		}
		case 'FragmentDefinition':
			return `fragment ${name(node.name)} on ${printType(node.typeCondition)} ${printSelectionSet(
				node.selectionSet,
				0
			)}`;
		default:
			return fail('definition', node);
	}
}

/**
 * Print a document, memoized on the node identity.
 *
 * The vendored documents are module-level constants, so the same object is
 * printed on every call for the life of the page; the cache turns a per-request
 * walk into a one-off. A `WeakMap` so a document that goes out of scope is not
 * retained by the cache.
 */
const printed = new WeakMap();

export function printDocument(document) {
	if (!isNode(document) || document.kind !== 'Document') return fail('document', document);

	const cached = printed.get(document);
	if (cached !== undefined) return cached;

	const definitions = document.definitions;
	if (!Array.isArray(definitions) || definitions.length === 0) {
		return fail('document definitions', definitions);
	}

	const text = definitions.map(printDefinition).join('\n\n');
	printed.set(document, text);
	return text;
}
