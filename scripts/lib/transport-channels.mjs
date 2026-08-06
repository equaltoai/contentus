/**
 * Which calls hand a GraphQL document to lesser — answered by PROVENANCE, not by
 * spelling, and never by silence.
 *
 * WHAT WAS WRONG THE FIRST TIME. This reader held a table of NAMES —
 * `{ callee: 'graphqlRequest', argument: 0 }` — and compared it with the lexical
 * identifier at a call site. A name is not a channel, and four import/variable
 * aliases each sent a document the gate never saw.
 *
 * WHAT WAS STILL WRONG THE SECOND TIME, and it is the more interesting failure.
 * The table was replaced by module-graph provenance, which is the right shape —
 * but the resolver answered `null` for every form it had not been taught, and
 * `null` meant "not a channel". A reader that says "no" when it means "I cannot
 * tell" is a fail-open with a data-flow analysis in front of it. Adversarial
 * review sent a dynamically assembled invalid document through eight of them and
 * every one exited 0/PASS:
 *
 *     graphqlRequest.call(null, DOC, {})           // Function.prototype
 *     graphqlRequest.apply(null, [DOC, {}])
 *     const bound = graphqlRequest.bind(null); bound(DOC, {})
 *     transport.nested.send(DOC, {})               // member chain deeper than one
 *     Object.assign({}, { send: graphqlRequest }).send(DOC, {})
 *     ({ graphqlRequest: send } = obj); send(DOC, {})   // destructuring ASSIGNMENT
 *     a12 = a11 = … = graphqlRequest; a12(DOC, {})      // past the convergence cap
 *     t.a.b.c.d.e.f.g.h.i.j.k.l(DOC, {})                // past the depth cap
 *
 * The last two are the ones worth naming precisely: the caps did not merely limit
 * work, they ANSWERED. A budget that returns "not a channel" on exhaustion has
 * converted a resource limit into a security claim.
 *
 * SO THIS MODULE HAS THREE ANSWERS, NOT TWO. Every resolution returns a channel, a
 * carrier (a module namespace or object that holds channels), `null` for something
 * this reading positively determined is not a transport, or UNDECIDABLE — which is
 * a finding, carrying the file, line and reason. Nothing returns `null` because it
 * ran out of budget, ran out of depth, or met a form it does not model.
 *
 * WHAT IS FOLLOWED, all rooted at the transport EXPORTS rather than at any name:
 *
 *   - import aliases, default and namespace imports, re-exports, aliased
 *     re-exports, `export * from`
 *   - variable aliases, aliases of aliases, and plain ASSIGNMENT to a name
 *   - object and array destructuring, in declarations AND in assignments
 *   - members of a namespace or object literal at ANY depth, including the static
 *     computed form `transport['graphqlRequest']`
 *   - object literals and `Object.assign` results, exported across modules
 *   - `Function.prototype.call`, `.apply` and `.bind`, with the document slot
 *     shifted or read out of the applied argument array
 *   - wrapper functions derived across files to a fixpoint: a function forwarding
 *     a parameter into a channel IS a channel at that parameter
 *
 * AND EVERYTHING ELSE FAILS CLOSED. A channel value that escapes into a position
 * this reading cannot follow — passed as an argument, returned, stored in an
 * array, spread into a call, applied with a non-literal argument list — is a
 * finding naming the channel, because the documents it goes on to send are exactly
 * the ones nobody can enumerate.
 *
 * CONVERGENCE IS BOUNDED BY THE LATTICE, NOT BY A GUESS. Both fixpoints are
 * monotone over finite sets — names in a file, exports in a tree — so they
 * terminate in at most `size + 1` rounds, and the bound is computed from the size
 * rather than picked. The remaining caps exist only to stop a pathological input
 * from running forever, and each one reports rather than answers.
 */
import ts from 'typescript';

/**
 * The transports themselves, named by the module that defines them.
 *
 * These are the ROOTS of the whole analysis: everything else is derived by
 * following the module graph out from here. Keep them in step with
 * `src/lib/cms/graphql.ts` and `src/lib/timelines/subscription.ts`;
 * `tests/graphql-contract.test.mjs` asserts each one really is an export of the
 * module named, so a transport that moves or is renamed fails rather than
 * quietly matching nothing.
 */
export const TRANSPORT_ROOTS = [
	{ module: 'src/lib/cms/graphql.ts', export: 'graphqlRequest', argument: 0 },
	{ module: 'src/lib/timelines/subscription.ts', export: 'subscribe', property: 'query' },
];

/**
 * Expression nesting this reader will walk before reporting.
 *
 * Generous, and it REPORTS on exhaustion rather than answering. The number is not
 * load-bearing for correctness — that is what the undecidable answer is for — it
 * only stops a pathological expression from costing unbounded time.
 */
const MAX_EXPRESSION_DEPTH = 64;

/** A hard stop on node visits per file, reported rather than silently obeyed. */
const MAX_FILE_WORK = 2_000_000;

/** The document slot two specs describe, for dedup and comparison. */
function slotKey(spec) {
	return typeof spec.argument === 'number' ? `arg:${spec.argument}` : `prop:${spec.property}`;
}

function unwrap(node) {
	let current = node;
	for (;;) {
		if (ts.isParenthesizedExpression(current)) current = current.expression;
		else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))
			current = current.expression;
		else if (ts.isNonNullExpression(current)) current = current.expression;
		else if (ts.isSatisfiesExpression?.(current)) current = current.expression;
		else return current;
	}
}

/** A static property name for `a.b` and `a['b']`; null for `a[expr]`. */
function staticMemberName(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node)) {
		const argument = unwrap(node.argumentExpression);
		if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
			return argument.text;
		}
		return null;
	}
	return null;
}

/** The name a call site is WRITTEN with, for the shape-narrowed backstop only. */
export function writtenCalleeName(expression) {
	const node = unwrap(expression);
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node)) return staticMemberName(node);
	return null;
}

/* -------------------------------------------------------------------------
 * The three answers
 * ---------------------------------------------------------------------- */

const channel = (spec) => ({ kind: 'channel', spec });
const carrier = (members) => ({ kind: 'carrier', members });
const namespaceOf = (file) => ({ kind: 'namespace', file });
const undecidable = (node, reason) => ({ kind: 'undecidable', node, reason });

/** Does this answer carry a transport at all, in any shape? */
const carriesChannel = (answer) =>
	answer !== null &&
	(answer.kind === 'channel' ||
		answer.kind === 'namespace' ||
		answer.kind === 'undecidable' ||
		(answer.kind === 'carrier' && answer.members.size > 0));

/** A stable identity for an answer, so the fixpoint can tell a round changed. */
function answerKey(answer) {
	if (!answer) return 'none';
	if (answer.kind === 'channel') return `channel:${slotKey(answer.spec)}`;
	if (answer.kind === 'namespace') return `namespace:${answer.file}`;
	if (answer.kind === 'undecidable') return `undecidable`;
	return `carrier:${[...answer.members]
		.map(([name, value]) => `${name}=${answerKey(value)}`)
		.sort()
		.join(',')}`;
}

/**
 * Every name this file DECLARES — imports, variables, parameters, functions,
 * destructured bindings.
 *
 * The backstop needs this to stay precise. A bare identifier that the file binds
 * is not an unfollowable receiver: provenance already answered it, and the answer
 * was "not the transport". A test fixture writing `function load(graphqlRequest)`
 * and calling `graphqlRequest(DOC)` is passing its own parameter, which is
 * exactly what the shadowing says. Accusing it would be the backstop reporting
 * the reading's own vocabulary rather than a gap in it — and would make the gate
 * fire on correct code, which is the pressure that gets gates loosened.
 */
export function declaredNames(sourceFile) {
	const names = new Set();
	const add = (node) => {
		if (!node) return;
		if (ts.isIdentifier(node)) names.add(node.text);
		else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
			for (const element of node.elements) {
				if (ts.isBindingElement(element)) add(element.name);
			}
		}
	};
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
			add(node.name);
		} else if (
			(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name)
		) {
			names.add(node.name.text);
		} else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
			names.add(node.name.text);
		} else if (ts.isImportClause(node) && node.name) {
			names.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return names;
}

/* -------------------------------------------------------------------------
 * Reading one file's import/export surface
 * ---------------------------------------------------------------------- */

function surfaceOf(sourceFile) {
	const named = new Map(); // local -> { module, exported }
	const namespaces = new Map(); // local -> module
	const reExports = new Map(); // exportName -> { module, exported }
	const starReExports = [];
	const localExports = new Map(); // exportName -> localName

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (!statement.importClause || statement.importClause.isTypeOnly) continue;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const module = statement.moduleSpecifier.text;

			if (statement.importClause.name) {
				named.set(statement.importClause.name.text, { module, exported: 'default' });
			}
			const bindings = statement.importClause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				namespaces.set(bindings.name.text, module);
			} else if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (element.isTypeOnly) continue;
					named.set(element.name.text, {
						module,
						exported: (element.propertyName ?? element.name).text,
					});
				}
			}
			continue;
		}

		if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
			const module =
				statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
					? statement.moduleSpecifier.text
					: null;
			if (!statement.exportClause) {
				if (module) starReExports.push(module);
				continue;
			}
			if (ts.isNamespaceExport(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				if (element.isTypeOnly) continue;
				const local = (element.propertyName ?? element.name).text;
				if (module) reExports.set(element.name.text, { module, exported: local });
				else localExports.set(element.name.text, local);
			}
			continue;
		}

		// `export const x = …` / `export function x() {}` publish their own name.
		const exported = statement.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
		);
		if (!exported) continue;
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					localExports.set(declaration.name.text, declaration.name.text);
				}
			}
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			localExports.set(statement.name.text, statement.name.text);
		}
	}

	return { named, namespaces, reExports, starReExports, localExports };
}

/**
 * Function-likes by name, with their parameter names.
 *
 * EXPORTED BECAUSE NODE IDENTITY DOES NOT SURVIVE A SECOND PARSE. `documentsIn`
 * parses each file for its own walk, so a `functions` map built here holds nodes
 * from a different AST, and `enclosingNamedFunction`'s `entry.node === current`
 * never matched across the two. That mismatch was silent and expensive: every
 * private forwarding helper looked uncovered, and three correct call sites were
 * reported as unreadable documents. Each reader builds its map from the AST it is
 * walking; only the NAMES cross between them.
 */
export function functionsIn(sourceFile) {
	const functions = new Map();
	const record = (name, node) => {
		if (!name) return;
		if (functions.has(name)) {
			// Two functions, one name: which one a call site means is not decidable,
			// so nothing is derived from either.
			functions.set(name, null);
			return;
		}
		functions.set(name, {
			node,
			parameters: node.parameters.map((parameter) =>
				ts.isIdentifier(parameter.name) ? parameter.name.text : null
			),
		});
	};
	const visit = (node) => {
		if (ts.isFunctionDeclaration(node) && node.name) record(node.name.text, node);
		else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(unwrap(node.initializer)) ||
				ts.isFunctionExpression(unwrap(node.initializer)))
		) {
			record(node.name.text, unwrap(node.initializer));
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return functions;
}

/* -------------------------------------------------------------------------
 * Resolution
 * ---------------------------------------------------------------------- */

/** Is this call `Object.assign(...)`, spelled in a way the file has not shadowed? */
function isObjectAssign(call, ctx) {
	const callee = unwrap(call.expression);
	if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
	if (staticMemberName(callee) !== 'assign') return false;
	const base = unwrap(callee.expression);
	// `Object` must be the global. A file that declares its own `Object` is talking
	// about something else, and guessing would be the name-matching this module
	// exists to stop doing.
	return ts.isIdentifier(base) && base.text === 'Object' && !ctx.declared.has('Object');
}

/**
 * Resolve an expression to the transport it refers to.
 *
 * Returns a channel, a carrier, a namespace, `null` when this reading positively
 * determined the expression is not a transport, or an UNDECIDABLE answer when it
 * could not tell. The last one is the whole repair: the previous version returned
 * `null` in that case, which is how eight ordinary JavaScript forms became
 * bypasses.
 */
function resolveExpression(node, ctx, depth = 0) {
	if (!node) return null;
	// Memoized per node, and invalidated the moment a binding changes. The escape
	// walk below asks about every expression in the file and then about its parent,
	// so without this the object-literal case alone is quadratic. The generation
	// counter is what keeps it honest: a cache that outlived a binding change would
	// answer with a fixpoint round that is no longer current.
	const cached = ctx.cache.get(node);
	if (cached !== undefined && cached.generation === ctx.generation) return cached.answer;
	const answer = resolveExpressionUncached(node, ctx, depth);
	if (depth === 0) ctx.cache.set(node, { generation: ctx.generation, answer });
	return answer;
}

function resolveExpressionUncached(node, ctx, depth) {
	if (depth > MAX_EXPRESSION_DEPTH) {
		return undecidable(
			node,
			`this expression nests deeper than ${MAX_EXPRESSION_DEPTH} levels, which is past what ` +
				'this reader walks. A depth budget must report what it did not read; answering ' +
				'"not a transport" would make the budget a security claim.'
		);
	}
	if (ctx.spend(1)) return undecidable(node, ctx.budgetReason);

	const current = unwrap(node);

	if (ts.isIdentifier(current)) return ctx.names.get(current.text) ?? null;

	// --- member access, at any depth ----------------------------------------
	if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		const base = resolveExpression(current.expression, ctx, depth + 1);
		if (base === null) return null;
		if (base.kind === 'undecidable') return base;

		const property = staticMemberName(current);
		if (property === null) {
			return undecidable(
				current,
				'a member of a module or object that carries a GraphQL transport is selected by a ' +
					'computed key, so this reader cannot tell whether the call is a transport call. ' +
					'An undecidable channel is a finding, not a skip.'
			);
		}

		if (base.kind === 'namespace') return ctx.exportsOf(base.file).get(property) ?? null;
		if (base.kind === 'carrier') return base.members.get(property) ?? null;
		// A channel's own members are `call`/`apply`/`bind` and friends; those are
		// resolved at the CALL site, where the argument shift is known.
		return null;
	}

	// --- an inline object literal that holds transports ----------------------
	if (ts.isObjectLiteralExpression(current)) {
		const members = objectMembers(current, ctx, depth);
		return members.size ? carrier(members) : null;
	}

	// --- calls: Object.assign, and .bind ------------------------------------
	if (ts.isCallExpression(current)) {
		if (isObjectAssign(current, ctx)) return resolveObjectAssign(current, ctx, depth);

		const bound = resolveBoundChannel(current, ctx, depth);
		if (bound !== undefined) return bound;

		// Any other call's return value. This reading does not model returns, so it
		// says so rather than answering: `pick(graphqlRequest)` returning the
		// transport is exactly the shape that must not read as "not a transport".
		// Only reported when a transport actually flows in, so ordinary calls stay
		// silent.
		const flows = current.arguments.some((argument) =>
			carriesChannel(resolveExpression(argument, ctx, depth + 1))
		);
		if (flows) {
			return undecidable(
				current,
				'a GraphQL transport is used as a value rather than called: it is handed to a call ' +
					'this reader cannot follow, so where it is invoked from there — and what documents ' +
					'it sends — is unknown.'
			);
		}
		return null;
	}

	// --- a conditional yields either arm ------------------------------------
	if (ts.isConditionalExpression(current)) {
		const whenTrue = resolveExpression(current.whenTrue, ctx, depth + 1);
		const whenFalse = resolveExpression(current.whenFalse, ctx, depth + 1);
		if (whenTrue === null) return whenFalse;
		if (whenFalse === null) return whenTrue;
		if (answerKey(whenTrue) === answerKey(whenFalse)) return whenTrue;
		return undecidable(
			current,
			'a conditional selects between two different GraphQL transports, so which one a call ' +
				'reaches is not decidable from source.'
		);
	}

	// `a ?? b`, `a || b` — same reasoning, either side may be the value.
	if (ts.isBinaryExpression(current)) {
		const operator = current.operatorToken.kind;
		if (
			operator === ts.SyntaxKind.QuestionQuestionToken ||
			operator === ts.SyntaxKind.BarBarToken ||
			operator === ts.SyntaxKind.AmpersandAmpersandToken
		) {
			const left = resolveExpression(current.left, ctx, depth + 1);
			const right = resolveExpression(current.right, ctx, depth + 1);
			if (left === null) return right;
			if (right === null) return left;
			return answerKey(left) === answerKey(right)
				? left
				: undecidable(
						current,
						'two different GraphQL transports may be selected here, so which one a call ' +
							'reaches is not decidable from source.'
					);
		}
	}

	return null;
}

/** Resolved members of an object literal, dropping the ones that are not transports. */
function objectMembers(literal, ctx, depth) {
	const members = new Map();
	for (const member of literal.properties) {
		if (ts.isShorthandPropertyAssignment(member)) {
			const answer = resolveExpression(member.name, ctx, depth + 1);
			if (answer) members.set(member.name.text, answer);
			continue;
		}
		if (ts.isSpreadAssignment(member)) {
			// `{ ...transport }` copies whatever it holds. Followed when the spread
			// resolves to a carrier; reported when a transport is spread from
			// something this reader cannot enumerate.
			const answer = resolveExpression(member.expression, ctx, depth + 1);
			if (!answer) continue;
			if (answer.kind === 'carrier') {
				for (const [name, value] of answer.members)
					if (!members.has(name)) members.set(name, value);
			} else {
				members.set(
					'…spread…',
					undecidable(
						member,
						'a GraphQL transport is spread into an object literal from a value whose members ' +
							'this reader cannot enumerate, so which properties carry a transport is unknown.'
					)
				);
			}
			continue;
		}
		if (!ts.isPropertyAssignment(member)) continue;
		const key =
			ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
		if (key === null) {
			const answer = resolveExpression(member.initializer, ctx, depth + 1);
			if (carriesChannel(answer)) {
				members.set(
					'…computed…',
					undecidable(
						member,
						'a GraphQL transport is stored under a computed property name, so the name a ' +
							'caller would select it by is unknown.'
					)
				);
			}
			continue;
		}
		const answer = resolveExpression(member.initializer, ctx, depth + 1);
		if (answer) members.set(key, answer);
	}
	return members;
}

/** `Object.assign(target, ...sources)` — the union of what its arguments carry. */
function resolveObjectAssign(call, ctx, depth) {
	const members = new Map();
	let sawTransport = false;

	for (const argument of call.arguments) {
		if (ts.isSpreadElement(argument)) {
			return undecidable(
				call,
				'`Object.assign` is called with a spread argument list, so which objects it merges — ' +
					'and therefore which properties carry a GraphQL transport — is unknown.'
			);
		}
		const answer = resolveExpression(argument, ctx, depth + 1);
		if (answer === null) continue;
		sawTransport = true;
		if (answer.kind === 'carrier') {
			for (const [name, value] of answer.members) members.set(name, value);
			continue;
		}
		return undecidable(
			call,
			'`Object.assign` merges a value that carries a GraphQL transport but whose properties ' +
				'this reader cannot enumerate, so the result cannot be followed.'
		);
	}

	if (!sawTransport) return null;
	return members.size ? carrier(members) : null;
}

/**
 * `chan.call(…)`, `chan.apply(…)`, `chan.bind(…)` as a VALUE.
 *
 * Returns `undefined` when the call is not one of these — distinct from `null`,
 * which would claim the expression is not a transport.
 */
function resolveBoundChannel(call, ctx, depth) {
	const callee = unwrap(call.expression);
	if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee))
		return undefined;
	const method = staticMemberName(callee);
	if (method !== 'bind' && method !== 'call' && method !== 'apply') return undefined;

	const target = resolveExpression(callee.expression, ctx, depth + 1);
	if (target === null) return undefined;
	if (target.kind !== 'channel') {
		return target.kind === 'undecidable'
			? target
			: undecidable(
					call,
					`\`${method}\` is invoked on a value that carries a GraphQL transport, and this ` +
						'reader cannot say which transport the result is.'
				);
	}

	// `.call` and `.apply` INVOKE; their value is the transport's return value, not
	// a transport. Only `.bind` produces a callable this reader must keep following.
	if (method !== 'bind') return null;

	const partials = call.arguments.slice(1);
	if (partials.some((argument) => ts.isSpreadElement(argument))) {
		return undecidable(
			call,
			'`bind` is given a spread argument list, so how many arguments it consumes — and ' +
				'therefore where the document lands in the bound call — is unknown.'
		);
	}
	if (typeof target.spec.argument !== 'number') return channel(target.spec);

	const shifted = target.spec.argument - partials.length;
	// A negative slot means the document was already supplied at bind time; the bind
	// CALL is the document site and `channelCall` reports it there.
	if (shifted < 0) return null;
	return channel({ ...target.spec, argument: shifted });
}

/* -------------------------------------------------------------------------
 * Call sites
 * ---------------------------------------------------------------------- */

/** The expression occupying a channel's document slot, given the effective args. */
export function documentSlotIn(args, spec) {
	if (typeof spec.argument === 'number') return args[spec.argument] ?? null;
	for (const argument of args) {
		const object = unwrap(argument);
		if (!ts.isObjectLiteralExpression(object)) continue;
		for (const member of object.properties) {
			if (ts.isShorthandPropertyAssignment(member) && member.name.text === spec.property) {
				return member.name;
			}
			if (!ts.isPropertyAssignment(member)) continue;
			const key =
				ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
			if (key === spec.property) return member.initializer;
		}
	}
	return null;
}

/** Back-compatible view for callers holding a call node. */
export function documentSlot(call, spec) {
	return documentSlotIn([...call.arguments], spec);
}

/** Whether a call could carry a document for any of these specs — the backstop's shape test. */
export function callMatchesAnySlot(call, specs) {
	return specs.some((spec) => documentSlot(call, spec) !== null);
}

/**
 * What a call site does with a transport, if anything.
 *
 * `{ spec, args }` for a transport call, `{ undecidable }` for one this reader
 * cannot follow, `null` for a call that is not a transport call. The four shapes
 * folded in here — direct, `.call`, `.apply`, `.bind`-with-the-document — were
 * each a demonstrated bypass, and each is ordinary JavaScript.
 */
export function channelCall(call, ctx) {
	const callee = unwrap(call.expression);

	const direct = resolveExpression(callee, ctx);
	if (direct?.kind === 'channel') {
		const args = [...call.arguments];
		// A spread ahead of the document slot moves it by an unknown amount.
		const spreadAt = args.findIndex((argument) => ts.isSpreadElement(argument));
		if (
			spreadAt >= 0 &&
			(typeof direct.spec.argument !== 'number' || spreadAt <= direct.spec.argument)
		) {
			return {
				undecidable: undecidable(
					call,
					'a GraphQL transport is called with a spread argument list, so which value lands ' +
						'in its document slot is unknown.'
				),
			};
		}
		return { spec: direct.spec, args, via: describe(callee) };
	}
	if (direct?.kind === 'undecidable') return { undecidable: direct };
	if (direct?.kind === 'carrier' || direct?.kind === 'namespace') {
		return {
			undecidable: undecidable(
				call,
				'a value that carries a GraphQL transport is called directly, which this reader ' +
					'cannot resolve to a single transport.'
			),
		};
	}

	// --- Function.prototype.call / .apply / .bind ---------------------------
	if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
		const method = staticMemberName(callee);
		if (method === 'call' || method === 'apply' || method === 'bind') {
			const target = resolveExpression(callee.expression, ctx);
			if (target?.kind === 'undecidable') return { undecidable: target };
			if (target?.kind === 'channel') {
				const rest = call.arguments.slice(1);
				if (method === 'apply') {
					const list = rest[0] ? unwrap(rest[0]) : null;
					if (!list || !ts.isArrayLiteralExpression(list)) {
						return {
							undecidable: undecidable(
								call,
								'`apply` hands a GraphQL transport an argument list this reader cannot read ' +
									'as a literal array, so which value is the document is unknown.'
							),
						};
					}
					if (list.elements.some((element) => ts.isSpreadElement(element))) {
						return {
							undecidable: undecidable(
								call,
								'`apply` hands a GraphQL transport an argument array containing a spread, so ' +
									'which value lands in its document slot is unknown.'
							),
						};
					}
					return {
						spec: target.spec,
						args: [...list.elements],
						via: `${describe(callee.expression)}.apply`,
					};
				}
				if (rest.some((argument) => ts.isSpreadElement(argument))) {
					return {
						undecidable: undecidable(
							call,
							`\`${method}\` hands a GraphQL transport a spread argument list, so which value ` +
								'lands in its document slot is unknown.'
						),
					};
				}
				// `.call` invokes with the arguments shifted by one. `.bind` may also
				// supply the document up front, and when it does this IS the site.
				return { spec: target.spec, args: rest, via: `${describe(callee.expression)}.${method}` };
			}
		}
	}

	return null;
}

/** The nearest named function-like ancestor that this file could derive from. */
export function enclosingNamedFunction(node, functions) {
	for (let current = node.parent; current; current = current.parent) {
		if (
			ts.isFunctionDeclaration(current) ||
			ts.isArrowFunction(current) ||
			ts.isFunctionExpression(current) ||
			ts.isMethodDeclaration(current)
		) {
			for (const [name, entry] of functions) {
				if (entry && entry.node === current) return { name, entry };
			}
			return null;
		}
	}
	return null;
}

/* -------------------------------------------------------------------------
 * The channel graph
 * ---------------------------------------------------------------------- */

/**
 * Work out every local name, in every file, that refers to a GraphQL transport.
 *
 * `sourceOf(file)` returns the file's executable script; `resolveSync(specifier,
 * fromFile)` returns a repository-relative file path or null. Both are supplied
 * by the caller, because resolution belongs to the loader and this module must
 * not invent one.
 *
 * Iterates to a fixpoint: a wrapper discovered in round N makes its callers
 * channel sites in round N+1, and a wrapper around a wrapper resolves in N+2. The
 * bound is the SIZE of the lattice rather than a guessed constant — the review
 * defeated the guessed one with a twelve-hop alias chain — and exhausting it is a
 * finding rather than an answer.
 */
export function buildChannelGraph({ files, sourceOf, resolveSync, roots = TRANSPORT_ROOTS }) {
	const parsed = new Map();
	const parse = (file) => {
		if (!parsed.has(file)) {
			let sourceFile = null;
			try {
				sourceFile = ts.createSourceFile(
					file,
					sourceOf(file),
					ts.ScriptTarget.Latest,
					true,
					scriptKindOf(file)
				);
			} catch {
				sourceFile = null;
			}
			parsed.set(file, sourceFile);
		}
		return parsed.get(file);
	};

	const fileSet = new Set(files);
	/** file -> Map<exportName, answer> */
	const exported = new Map();
	const exportsOf = (file) => exported.get(file) ?? new Map();

	// Seed: the transports themselves.
	for (const root of roots) {
		if (!exported.has(root.module)) exported.set(root.module, new Map());
		exported.get(root.module).set(
			root.export,
			channel({
				...(typeof root.argument === 'number'
					? { argument: root.argument }
					: { property: root.property }),
				origin: `${root.module}#${root.export}`,
			})
		);
	}

	const perFile = new Map();
	/** file -> Map<key, finding>, rebuilt each round so nothing double-reports. */
	const resolutionFindings = new Map();

	// The lattice is finite and the transfer functions are monotone, so the
	// fixpoint terminates in at most one round per file plus one to observe
	// stability. Computed, not guessed — a constant is what the twelve-hop alias
	// chain walked past.
	const maxRounds = files.length + 2;
	let changed = true;
	let round = 0;

	for (; changed && round < maxRounds; round += 1) {
		changed = false;

		for (const file of files) {
			const sourceFile = parse(file);
			if (!sourceFile) continue;

			const roundFindings = new Map();
			const result = analyseFile({
				file,
				sourceFile,
				roots,
				exportsOf,
				resolveSync,
				report: (node, reason, name) => {
					const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
					const label = name ?? '<transport>';
					roundFindings.set(`${line}:${label}:${reason}`, { file, line, name: label, reason });
				},
			});
			resolutionFindings.set(file, roundFindings);

			const before = exportsOf(file);
			const publishes = result.publishes;
			if (
				before.size !== publishes.size ||
				[...publishes].some(
					([name, answer]) => answerKey(before.get(name) ?? null) !== answerKey(answer)
				)
			) {
				changed = true;
			}
			if (publishes.size) exported.set(file, publishes);
			else exported.delete(file);

			perFile.set(file, result.bindings);
		}
	}

	const findings = [];
	for (const [, perRound] of resolutionFindings) findings.push(...perRound.values());

	// A fixpoint that has not settled has not answered. Reported rather than
	// obeyed: the whole defect this module is repairing is a budget that returned
	// "not a transport" when it meant "I stopped looking".
	if (changed) {
		findings.push({
			file: '<transport graph>',
			line: 0,
			name: '<fixpoint>',
			reason:
				`the transport analysis had not converged after ${round} rounds over ${files.length} ` +
				'modules, so which names refer to a GraphQL transport is not fully determined. An ' +
				'unconverged analysis is a finding, not a smaller answer.',
		});
	}

	// Every name a channel is PUBLISHED under, for the shape-narrowed backstop.
	//
	// Published only — not every local binding. A file-private wrapper is called
	// nowhere but its own file, where provenance already answers, so putting its
	// name here would accuse unrelated code elsewhere of being a transport: a
	// derived helper called `run` in one module made `options.run(id)` in another
	// a finding. The backstop exists for a receiver this reader could not follow,
	// not for a name someone else happened to reuse.
	const specsByName = new Map();
	const remember = (name, spec) => {
		if (!specsByName.has(name)) specsByName.set(name, []);
		const specs = specsByName.get(name);
		if (!specs.some((existing) => slotKey(existing) === slotKey(spec))) specs.push(spec);
	};
	for (const root of roots) {
		remember(root.export, typeof root.argument === 'number' ? root : { property: root.property });
	}
	for (const [, publishes] of exported) {
		for (const [name, answer] of publishes) {
			if (answer?.kind === 'channel') remember(name, answer.spec);
			else if (answer?.kind === 'carrier') {
				for (const [member, value] of answer.members) {
					if (value?.kind === 'channel') remember(member, value.spec);
				}
			}
		}
	}

	return {
		bindingsFor: (file) => perFile.get(file) ?? null,
		exportedChannels: (file) => exportsOf(file),
		/** The channel an expression in `file` refers to, or null. */
		channelAt: (file, expression) => {
			const bindings = perFile.get(file);
			if (!bindings) return null;
			const answer = resolveExpression(expression, bindings.ctx);
			return answer?.kind === 'channel' ? answer.spec : null;
		},
		/** What a call site in `file` does with a transport. */
		callAt: (file, call) => {
			const bindings = perFile.get(file);
			if (!bindings) return null;
			return channelCall(call, bindings.ctx);
		},
		specsByName,
		files: fileSet,
		findings,
	};
}

function scriptKindOf(file) {
	if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
	if (/\.(js|mjs|cjs)$/i.test(file)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/**
 * One file's bindings, resolved to a local fixpoint.
 *
 * The local loop has the same property as the outer one: it is monotone over the
 * names the file declares, so it settles within `declared + 2` passes, and a pass
 * budget that ran out reports rather than answers. The review's twelve-hop reverse
 * alias chain — `const a12 = a11, a11 = a10, …, a1 = graphqlRequest` — walked past
 * a hard-coded eight and came out the other side as "not a transport".
 */
function analyseFile({ file, sourceFile, roots, exportsOf, resolveSync, report }) {
	const surface = surfaceOf(sourceFile);
	const functions = functionsIn(sourceFile);
	const declared = declaredNames(sourceFile);

	const resolve = (specifier) => {
		try {
			return resolveSync(specifier, file);
		} catch {
			return null;
		}
	};

	/** local -> answer, for names in this file that carry a transport. */
	const names = new Map();

	let work = 0;
	const ctx = {
		names,
		declared,
		exportsOf,
		cache: new Map(),
		generation: 0,
		budgetReason:
			`this file's transport analysis exceeded ${MAX_FILE_WORK} resolution steps, so which ` +
			'names refer to a GraphQL transport was not fully determined here.',
		spend(cost) {
			work += cost;
			return work > MAX_FILE_WORK;
		},
	};

	// Namespace imports first: they are the base of every `ns.member` chain.
	for (const [local, module] of surface.namespaces) {
		const target = resolve(module);
		if (target) names.set(local, namespaceOf(target));
	}

	// Imports of a channel export, including aliases and defaults.
	for (const [local, origin] of surface.named) {
		const target = resolve(origin.module);
		if (!target) continue;
		const answer = exportsOf(target).get(origin.exported);
		if (answer) names.set(local, answer);
	}
	ctx.generation += 1;

	// Local flow, to a fixpoint over the names this file declares.
	const maxPasses = declared.size + 2;
	let pass = 0;
	let grew = true;
	for (; grew && pass < maxPasses; pass += 1) {
		grew = false;
		const bind = (name, answer) => {
			if (!answer) return;
			const existing = names.get(name) ?? null;
			if (answerKey(existing) === answerKey(answer)) return;
			names.set(name, answer);
			// Every cached resolution was computed against the previous binding set.
			ctx.generation += 1;
			grew = true;
		};

		const visit = (node) => {
			// `const send = graphqlRequest`, `const { graphqlRequest: send } = ns`,
			// `const [a] = [chan]`.
			if (ts.isVariableDeclaration(node) && node.initializer) {
				bindTarget(node.name, node.initializer, ctx, bind);
			}

			// `send = graphqlRequest`, `({ graphqlRequest: send } = obj)`,
			// `[send] = [graphqlRequest]`. Assignment was entirely absent before, and
			// it is the plainest form there is.
			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				bindTarget(node.left, node.right, ctx, bind);
			}

			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	if (grew) {
		report(
			sourceFile,
			`this file's alias analysis had not settled after ${pass} passes over ${declared.size} ` +
				'declared names, so which of them refer to a GraphQL transport is not fully ' +
				'determined. An unconverged pass is a finding, not a smaller answer.',
			'<alias fixpoint>'
		);
	}

	// Wrappers: a function forwarding a parameter into a channel is itself a
	// channel at that parameter.
	const derived = new Map();
	const visitCalls = (node) => {
		if (ts.isCallExpression(node)) {
			const outcome = channelCall(node, ctx);
			if (outcome && !outcome.undecidable) {
				const slot = documentSlotIn(outcome.args, outcome.spec);
				if (slot && ts.isIdentifier(unwrap(slot))) {
					const passed = unwrap(slot).text;
					const enclosing = enclosingNamedFunction(node, functions);
					if (enclosing) {
						const index = enclosing.entry.parameters.indexOf(passed);
						if (index >= 0 && !derived.has(enclosing.name)) {
							derived.set(
								enclosing.name,
								channel({ argument: index, origin: `${file}#${enclosing.name}` })
							);
						}
					}
				}
			}
		}
		ts.forEachChild(node, visitCalls);
	};
	visitCalls(sourceFile);
	for (const [name, answer] of derived) {
		if (!names.has(name)) {
			names.set(name, answer);
			ctx.generation += 1;
		}
	}

	// What this file PUBLISHES.
	//
	// SEEDED FIRST. A transport's own module publishes it by defining it, not by
	// aliasing anything, so nothing below would rediscover it — and recomputing
	// `publishes` from scratch would delete the root and leave the entire graph
	// empty. That failure is silent in the worst way: every real call site falls
	// through to the backstop and the gate reports its own blindness as findings
	// against correct code.
	const publishes = new Map();
	for (const root of roots) {
		if (root.module !== file) continue;
		publishes.set(
			root.export,
			channel({
				...(typeof root.argument === 'number'
					? { argument: root.argument }
					: { property: root.property }),
				origin: `${root.module}#${root.export}`,
			})
		);
	}

	for (const [exportName, local] of surface.localExports) {
		const answer = names.get(local);
		if (answer) publishes.set(exportName, answer);
	}
	for (const [exportName, origin] of surface.reExports) {
		const target = resolve(origin.module);
		if (!target) continue;
		const answer = exportsOf(target).get(origin.exported);
		if (answer) publishes.set(exportName, answer);
	}
	for (const module of surface.starReExports) {
		const target = resolve(module);
		if (!target) continue;
		for (const [exportName, answer] of exportsOf(target)) {
			if (!publishes.has(exportName)) publishes.set(exportName, answer);
		}
	}

	return {
		publishes,
		bindings: { names, functions, sourceFile, ctx, declared },
	};
}

/**
 * Bind whatever a declaration or assignment target names, from whatever the value
 * side resolves to.
 *
 * Covers the plain name, object destructuring (declaration `{ a: b }` and the
 * ASSIGNMENT form, which TypeScript parses as an object literal on the left) and
 * array destructuring. The assignment form was the review's probe F, and it was
 * absent entirely — the previous reader only ever looked at declarations.
 */
function bindTarget(target, value, ctx, bind) {
	const name = unwrap(target);

	if (ts.isIdentifier(name)) {
		bind(name.text, resolveExpression(value, ctx));
		return;
	}

	// `const { a: b } = value` / `let { a: b } = value` (binding pattern form)
	if (ts.isObjectBindingPattern(name)) {
		const source = resolveExpression(value, ctx);
		for (const element of name.elements) {
			if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
			const property = element.propertyName
				? ((ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)) &&
						element.propertyName.text) ||
					null
				: element.name.text;
			if (!property) continue;
			bind(element.name.text, memberOf(source, property, ctx));
		}
		return;
	}

	// `({ a: b } = value)` — the ASSIGNMENT form. TypeScript parses the left side
	// as an object LITERAL, so it needs its own reading; missing it was a bypass.
	if (ts.isObjectLiteralExpression(name)) {
		const source = resolveExpression(value, ctx);
		for (const member of name.properties) {
			if (ts.isShorthandPropertyAssignment(member)) {
				bind(member.name.text, memberOf(source, member.name.text, ctx));
				continue;
			}
			if (!ts.isPropertyAssignment(member)) continue;
			const property =
				ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
			const local = unwrap(member.initializer);
			if (!property || !ts.isIdentifier(local)) continue;
			bind(local.text, memberOf(source, property, ctx));
		}
		return;
	}

	// `[a, b] = [chan, x]` and `const [a] = [chan]`.
	const elements = ts.isArrayBindingPattern(name)
		? name.elements
		: ts.isArrayLiteralExpression(name)
			? name.elements
			: null;
	if (!elements) return;

	const source = unwrap(value);
	const values = ts.isArrayLiteralExpression(source) ? source.elements : null;
	for (const [index, element] of elements.entries()) {
		const local = ts.isBindingElement(element) ? element.name : unwrap(element);
		if (!local || !ts.isIdentifier(local)) continue;
		if (values) {
			bind(local.text, resolveExpression(values[index], ctx));
			continue;
		}
		// Destructured out of something that is not a literal array. Only a finding
		// when a transport is actually in there.
		const answer = resolveExpression(value, ctx);
		if (carriesChannel(answer)) {
			bind(
				local.text,
				undecidable(
					element,
					'a GraphQL transport is destructured out of a value this reader cannot index, so ' +
						'which binding receives it is unknown.'
				)
			);
		}
	}
}

/**
 * The target shapes `bindTarget` actually reads.
 *
 * Kept beside the escape walk on purpose: the walk calls a target "followed"
 * exactly when the binder took it, and a list that drifted from the binder would
 * make the walk certify bindings nobody made.
 */
function bindTargetHandles(target) {
	const name = unwrap(target);
	return (
		ts.isIdentifier(name) ||
		ts.isObjectBindingPattern(name) ||
		ts.isObjectLiteralExpression(name) ||
		ts.isArrayBindingPattern(name) ||
		ts.isArrayLiteralExpression(name)
	);
}

/** One member of a resolved carrier/namespace, preserving undecidability. */
function memberOf(source, property, ctx) {
	if (!source) return null;
	if (source.kind === 'undecidable') return source;
	if (source.kind === 'namespace') return ctx.exportsOf(source.file).get(property) ?? null;
	if (source.kind === 'carrier') return source.members.get(property) ?? null;
	return null;
}

/* -------------------------------------------------------------------------
 * Escapes
 * ---------------------------------------------------------------------- */

/**
 * Every place a transport leaves this reading's sight, as findings.
 *
 * THIS IS THE HALF THAT MAKES SILENCE MEAN SOMETHING. The resolution above is
 * precision — it keeps the gate from accusing correct code. This is safety: a
 * transport value that is passed to a function, returned, stored, spread, or
 * applied with an argument list nobody can read goes on to send documents that no
 * enumeration can reach, so its ABSENCE from the document list is not evidence.
 *
 * Reported at the OUTERMOST expression that carries a transport, so one escape is
 * one finding rather than one per member in the chain.
 */
export function unfollowableChannelUses(file, bindings) {
	if (!bindings) return [];
	const { sourceFile, ctx } = bindings;
	const findings = [];
	const seen = new Set();
	const lineOf = (node) =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

	const push = (node, name, reason) => {
		const key = `${lineOf(node)}:${name}:${reason}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({ file, line: lineOf(node), name, reason });
	};

	const visit = (node) => {
		// TYPE POSITIONS CARRY NO VALUE. `submission: transport.VerdictSubmissionInput`
		// names the same module as `transport.submitDraftReview(…)` and loads nothing:
		// every one of these is erased before anything runs. The first version of this
		// walk accused two of them in `src/lib/cms/review.ts`, which is exactly the
		// shape that gets a gate loosened — a finding whose only honest repair is to
		// stop writing correct TypeScript.
		if (ts.isTypeNode(node) || ts.isQualifiedName(node) || ts.isTypeParameterDeclaration(node)) {
			return;
		}

		if (!ts.isExpression(node)) {
			ts.forEachChild(node, visit);
			return;
		}

		const answer = resolveExpression(node, ctx);
		if (!carriesChannel(answer)) {
			ts.forEachChild(node, visit);
			return;
		}

		if (answer.kind === 'undecidable') {
			push(node, describe(node), answer.reason);
			return;
		}

		const disposition = positionOf(node, ctx);
		if (disposition === 'followed') {
			// The reader accounted for this use; its parts are accounted for with it.
			return;
		}
		if (disposition === 'descend') {
			ts.forEachChild(node, visit);
			return;
		}

		push(
			node,
			describe(node),
			`a GraphQL transport reaches ${disposition}. This reader cannot follow where it is ` +
				'invoked from there, so the documents it sends are unknown — which is a finding ' +
				'rather than an absence.'
		);
	};

	visit(sourceFile);
	return findings;
}

/** A short label for a transport-bearing expression, for the finding's name. */
function describe(node) {
	const current = unwrap(node);
	if (ts.isIdentifier(current)) return current.text;
	if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		const base = describe(current.expression);
		const property = staticMemberName(current);
		return property === null ? `${base}[…]` : `${base}.${property}`;
	}
	if (ts.isCallExpression(current)) return `${describe(current.expression)}(…)`;
	if (ts.isObjectLiteralExpression(current)) return '{…}';
	return '<transport>';
}

/**
 * What the surrounding code does with a transport-bearing expression.
 *
 * `'followed'` — this reader accounted for it. `'descend'` — not itself an escape,
 * but its parts still need looking at. Anything else is the prose naming where the
 * value went.
 */
function positionOf(node, ctx) {
	const parent = node.parent;
	if (!parent) return 'descend';

	// The callee of a call: resolved at the call site.
	if (ts.isCallExpression(parent) && unwrap(parent.expression) === unwrap(node)) return 'followed';

	// The base of a member access, or of `.call`/`.apply`/`.bind`.
	if (
		(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
		parent.expression === node
	) {
		return 'followed';
	}

	// A declaration or assignment TARGET names a binding rather than using one, and
	// `bindTarget` has already read it. The whole left-hand subtree counts, which is
	// what covers `({ graphqlRequest: send } = …)` — an object literal in a position
	// where nothing is being constructed.
	if (ts.isVariableDeclaration(parent) && parent.name === node) return 'followed';
	if (
		ts.isBinaryExpression(parent) &&
		parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		parent.left === node &&
		bindTargetHandles(node)
	) {
		return 'followed';
	}

	// The value side, but ONLY when the target is a shape the binder reads. A
	// transport assigned into `obj.prop` is bound to nothing this reader tracks, and
	// calling that "followed" would lose it silently — which is the exact failure
	// mode this whole module is repairing, one level along.
	if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
		return bindTargetHandles(parent.name)
			? 'followed'
			: 'a declaration target this reader does not bind';
	}
	if (
		ts.isBinaryExpression(parent) &&
		parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		parent.right === node
	) {
		return bindTargetHandles(parent.left)
			? 'followed'
			: 'an assignment target this reader does not bind';
	}

	// Declaration and import/export positions name the binding, not a use.
	if (
		ts.isImportSpecifier(parent) ||
		ts.isImportClause(parent) ||
		ts.isNamespaceImport(parent) ||
		ts.isExportSpecifier(parent) ||
		ts.isParameter(parent) ||
		ts.isBindingElement(parent) ||
		ts.isFunctionDeclaration(parent)
	) {
		return 'followed';
	}

	// A property of an object literal that itself resolves as a carrier — the
	// carrier is what the reader follows, and it was checked as a whole.
	if (
		(ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
		parent.parent &&
		ts.isObjectLiteralExpression(parent.parent) &&
		carriesChannel(resolveExpression(parent.parent, ctx))
	) {
		return 'followed';
	}

	// An argument of `Object.assign`, whose result the reader resolved.
	if (
		ts.isCallExpression(parent) &&
		isObjectAssign(parent, ctx) &&
		carriesChannel(resolveExpression(parent, ctx))
	) {
		return 'followed';
	}

	// The subject of a bind/call/apply the reader resolved.
	if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) return 'descend';

	if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
		return 'a call as an argument, rather than being invoked';
	}
	if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
		return "a function's return value";
	}
	if (ts.isArrayLiteralExpression(parent)) return 'an array element';
	if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) return 'a spread';
	if (ts.isExportAssignment(parent)) return 'a default export';
	if (ts.isTemplateSpan(parent)) return 'string interpolation';

	return 'a position this reader does not model';
}
