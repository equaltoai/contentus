/**
 * Which calls hand a GraphQL document to lesser — answered by PROVENANCE, not by
 * spelling.
 *
 * WHAT WAS WRONG. This reader used to hold a table of names —
 * `{ callee: 'graphqlRequest', argument: 0 }` — and compare it with the lexical
 * identifier or property at a call site. A name is not a channel, and the
 * adversarial review demonstrated four bypasses that each sent a document the
 * gate never saw:
 *
 *     import { graphqlRequest as send } from './graphql';  send(document);
 *     const send = graphqlRequest;                          send(document);
 *     transport['graphqlRequest'](document);
 *     import { subscribe as open } from './subscription';   open({ query });
 *
 * Every one is ordinary JavaScript, none is obscure, and the same value passed
 * directly to `graphqlRequest` was caught — which is what proves the alias, and
 * not the value, was the bypass. Worse, pass 2's shape screen cannot rescue any of
 * them: a dynamically assembled anonymous operation has no `query` keyword left in
 * its literal chunks, so there is nothing to recognize.
 *
 * WHAT REPLACES IT. A channel is a MODULE EXPORT — `src/lib/cms/graphql.ts`'s
 * `graphqlRequest`, `src/lib/timelines/subscription.ts`'s `subscribe` — and this
 * module works out, per file, which local names refer to it. That question is
 * answered by following the module graph rather than by matching text, so it
 * survives every rename:
 *
 *   - import aliases and default/namespace imports
 *   - re-exports, aliased re-exports, and `export * from`
 *   - variable aliases, including aliases of aliases and destructuring
 *   - member access on a namespace or an object literal, including the STATIC
 *     computed form `transport['graphqlRequest']`
 *   - wrapper functions, local or exported, derived to a fixpoint: a function that
 *     forwards a parameter into a channel IS a channel at that parameter, and its
 *     callers — in any file — are then channel call sites too
 *
 * FAIL-CLOSED, IN THE TWO PLACES IT MATTERS.
 *
 *   1. A DOCUMENT that cannot be folded to text is a finding, never a skip. That
 *      is the caller's job and it already worked; this module's contribution is
 *      making sure the caller SEES the site.
 *   2. A CHANNEL REFERENCE this reading cannot follow is a finding too. A computed
 *      member access with a non-static key on an object that carries a channel
 *      (`transport[pick](document)`) names something undecidable, and a channel
 *      binding that escapes into a value — passed to a function, stored in an
 *      array — leaves this reading unable to say where it is called. Both report.
 *
 * AND A NAME-KEYED BACKSTOP, because a closed table over provenance still needs
 * one. If a call is written with a channel's name but the receiver could not be
 * resolved — `getTransport().graphqlRequest(document)` — provenance says nothing
 * and silence would be permission. Those report as unresolved. The backstop is
 * narrowed by SHAPE so it accuses only calls that could actually carry a document:
 * `subscribe` is also a store method and a push-manager method in this tree, and a
 * rule that fired on the name alone would be findings about something else, with a
 * disclosure as the only repair — which is how a gate stops being read.
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

const MAX_ROUNDS = 32;

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

/** Object literals bound to a `const`, as `local -> Map<property, expression>`. */
function objectLiteralsIn(sourceFile) {
	const objects = new Map();
	const visit = (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isObjectLiteralExpression(unwrap(node.initializer))
		) {
			const literal = unwrap(node.initializer);
			const members = new Map();
			for (const member of literal.properties) {
				if (ts.isShorthandPropertyAssignment(member)) {
					members.set(member.name.text, member.name);
				} else if (ts.isPropertyAssignment(member)) {
					const key =
						ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
							? member.name.text
							: null;
					if (key) members.set(key, member.initializer);
				}
			}
			objects.set(node.name.text, members);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return objects;
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
 * The channel graph
 * ---------------------------------------------------------------------- */

/**
 * Resolve an expression to the channel it refers to, or null.
 *
 * The four forms this has to see through, and each one was a demonstrated
 * bypass: a plain local name (which may be an import alias, a variable alias, or
 * a derived wrapper — all already folded into `names`), a member of a namespace
 * import, the STATIC computed form of the same, and a member of an object literal
 * that carries one. A non-static key resolves to null here and is reported
 * separately by `unfollowableChannelUses`; answering "not a channel" for
 * something undecidable is exactly the fail-open being removed.
 */
function channelReference(node, bindings, exportsOf, depth = 0) {
	if (!node || depth > 8) return null;
	const current = unwrap(node);
	const { names, namespaceFiles, objects } = bindings;

	if (ts.isIdentifier(current)) return names.get(current.text) ?? null;

	if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		const property = staticMemberName(current);
		if (property === null) return null;
		const base = unwrap(current.expression);
		if (!ts.isIdentifier(base)) return null;

		const namespaceFile = namespaceFiles.get(base.text);
		if (namespaceFile) return exportsOf(namespaceFile).get(property) ?? null;

		const object = objects.get(base.text);
		if (object && object.has(property)) {
			return channelReference(object.get(property), bindings, exportsOf, depth + 1);
		}
		return null;
	}
	return null;
}

/**
 * Work out every local name, in every file, that refers to a GraphQL transport.
 *
 * `sourceOf(file)` returns the file's executable script; `resolveSync(specifier,
 * fromFile)` returns a repository-relative file path or null. Both are supplied
 * by the caller, because resolution belongs to the loader and this module must
 * not invent one.
 *
 * Iterates to a fixpoint: a wrapper discovered in round N makes its callers
 * channel sites in round N+1, and a wrapper around a wrapper resolves in N+2.
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
					file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')
						? ts.ScriptKind.JS
						: ts.ScriptKind.TS
				);
			} catch {
				sourceFile = null;
			}
			parsed.set(file, sourceFile);
		}
		return parsed.get(file);
	};

	const fileSet = new Set(files);
	/** file -> Map<exportName, spec> */
	const exported = new Map();
	const exportsOf = (file) => exported.get(file) ?? new Map();

	// Seed: the transports themselves.
	for (const root of roots) {
		if (!exported.has(root.module)) exported.set(root.module, new Map());
		exported.get(root.module).set(root.export, {
			...(typeof root.argument === 'number'
				? { argument: root.argument }
				: { property: root.property }),
			origin: `${root.module}#${root.export}`,
		});
	}

	const perFile = new Map();
	let changed = true;

	for (let round = 0; changed && round < MAX_ROUNDS; round += 1) {
		changed = false;

		for (const file of files) {
			const sourceFile = parse(file);
			if (!sourceFile) continue;

			const surface = surfaceOf(sourceFile);
			const objects = objectLiteralsIn(sourceFile);
			const functions = functionsIn(sourceFile);

			const resolve = (specifier) => {
				try {
					return resolveSync(specifier, file);
				} catch {
					return null;
				}
			};

			/** local -> spec, for names in this file that ARE channels. */
			const names = new Map();
			/** local -> resolved module file, for namespace imports. */
			const namespaceFiles = new Map();

			for (const [local, module] of surface.namespaces) {
				const target = resolve(module);
				if (target) namespaceFiles.set(local, target);
			}

			// Imports of a channel export, including aliases and defaults.
			for (const [local, origin] of surface.named) {
				const target = resolve(origin.module);
				if (!target) continue;
				const spec = exportsOf(target).get(origin.exported);
				if (spec) names.set(local, spec);
			}

			/** Resolve an expression to a channel spec, or null. */
			const channelRef = (node, depth = 0) =>
				channelReference(node, { names, namespaceFiles, objects }, exportsOf, depth);

			// Variable aliases, to a fixpoint within the file: `const send =
			// graphqlRequest`, `const again = send`, `const { graphqlRequest: q } = ns`.
			for (let pass = 0, grew = true; grew && pass < 8; pass += 1) {
				grew = false;
				const visit = (node) => {
					if (ts.isVariableDeclaration(node) && node.initializer) {
						if (ts.isIdentifier(node.name)) {
							if (!names.has(node.name.text)) {
								const spec = channelRef(node.initializer);
								if (spec) {
									names.set(node.name.text, spec);
									grew = true;
								}
							}
						} else if (ts.isObjectBindingPattern(node.name)) {
							const base = unwrap(node.initializer);
							if (ts.isIdentifier(base)) {
								const namespaceFile = namespaceFiles.get(base.text);
								const object = objects.get(base.text);
								for (const element of node.name.elements) {
									if (!ts.isIdentifier(element.name)) continue;
									const property = element.propertyName
										? ((ts.isIdentifier(element.propertyName) ||
												ts.isStringLiteral(element.propertyName)) &&
												element.propertyName.text) ||
											null
										: element.name.text;
									if (!property || names.has(element.name.text)) continue;
									const spec = namespaceFile
										? (exportsOf(namespaceFile).get(property) ?? null)
										: object && object.has(property)
											? channelRef(object.get(property))
											: null;
									if (spec) {
										names.set(element.name.text, spec);
										grew = true;
									}
								}
							}
						}
					}
					ts.forEachChild(node, visit);
				};
				visit(sourceFile);
			}

			// Wrappers: a function forwarding a parameter into a channel is itself a
			// channel at that parameter.
			const derived = new Map();
			const visitCalls = (node) => {
				if (ts.isCallExpression(node)) {
					const spec = channelRef(node.expression);
					if (spec) {
						const slot = documentSlot(node, spec);
						if (slot && ts.isIdentifier(unwrap(slot))) {
							const passed = unwrap(slot).text;
							const enclosing = enclosingNamedFunction(node, functions);
							if (enclosing) {
								const index = enclosing.entry.parameters.indexOf(passed);
								if (index >= 0 && !derived.has(enclosing.name)) {
									derived.set(enclosing.name, {
										argument: index,
										origin: `${file}#${enclosing.name}`,
									});
								}
							}
						}
					}
				}
				ts.forEachChild(node, visitCalls);
			};
			visitCalls(sourceFile);
			for (const [name, spec] of derived) if (!names.has(name)) names.set(name, spec);

			// What this file PUBLISHES as a channel.
			//
			// SEEDED FIRST. A transport's own module publishes it by defining it, not
			// by aliasing anything, so nothing below would rediscover it — and
			// recomputing `publishes` from scratch would delete the root and leave
			// the entire graph empty. That failure is silent in the worst way: every
			// real call site falls through to the backstop and the gate reports its
			// own blindness as findings against correct code.
			const publishes = new Map();
			for (const root of roots) {
				if (root.module !== file) continue;
				publishes.set(root.export, {
					...(typeof root.argument === 'number'
						? { argument: root.argument }
						: { property: root.property }),
					origin: `${root.module}#${root.export}`,
				});
			}

			for (const [exportName, local] of surface.localExports) {
				const spec = names.get(local);
				if (spec) publishes.set(exportName, spec);
			}
			for (const [exportName, origin] of surface.reExports) {
				const target = resolve(origin.module);
				if (!target) continue;
				const spec = exportsOf(target).get(origin.exported);
				if (spec) publishes.set(exportName, spec);
			}
			for (const module of surface.starReExports) {
				const target = resolve(module);
				if (!target) continue;
				for (const [exportName, spec] of exportsOf(target)) {
					if (!publishes.has(exportName)) publishes.set(exportName, spec);
				}
			}

			const before = exportsOf(file);
			if (
				before.size !== publishes.size ||
				[...publishes].some(([name, spec]) => slotKey(before.get(name) ?? {}) !== slotKey(spec))
			) {
				changed = true;
			}
			if (publishes.size) exported.set(file, publishes);
			else exported.delete(file);

			// Which of this file's namespaces and object literals actually CARRY a
			// channel. The computed-key finding below is scoped to these, and the
			// scoping is the whole difference between a control and a nuisance: an
			// unscoped rule fires on `iconMap[kind]` and `errors[index]` — dozens of
			// findings about lookup tables, whose only repair is a disclosure, which
			// is how a gate stops being read.
			const channelNamespaces = new Set(
				[...namespaceFiles]
					.filter(([, target]) => exportsOf(target).size > 0)
					.map(([local]) => local)
			);
			const channelObjects = new Set(
				[...objects]
					.filter(([, members]) => [...members.values()].some((value) => channelRef(value)))
					.map(([local]) => local)
			);

			perFile.set(file, {
				names,
				namespaceFiles,
				objects,
				functions,
				sourceFile,
				channelNamespaces,
				channelObjects,
			});
		}
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
	for (const [, publishes] of exported) for (const [name, spec] of publishes) remember(name, spec);

	return {
		bindingsFor: (file) => perFile.get(file) ?? null,
		exportedChannels: (file) => exportsOf(file),
		/** The channel an expression in `file` refers to, or null. */
		channelAt: (file, expression) => {
			const bindings = perFile.get(file);
			if (!bindings) return null;
			return channelReference(expression, bindings, exportsOf);
		},
		specsByName,
		files: fileSet,
	};
}

/** The expression occupying a channel's document slot at a call, or null. */
export function documentSlot(call, spec) {
	if (typeof spec.argument === 'number') return call.arguments[spec.argument] ?? null;
	for (const argument of call.arguments) {
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

/** Whether a call could carry a document for any of these specs — the backstop's shape test. */
export function callMatchesAnySlot(call, specs) {
	return specs.some((spec) => documentSlot(call, spec) !== null);
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

/**
 * Channel references this reading could not follow, as findings.
 *
 * Two shapes, and both are genuinely undecidable rather than merely awkward:
 * a computed member access with a non-static key on something carrying a channel,
 * and a channel binding used as a VALUE rather than called. Reporting them is what
 * keeps "this reader saw no transport call" from meaning "there was none".
 */
export function unfollowableChannelUses(file, bindings) {
	if (!bindings) return [];
	const { names, sourceFile, channelNamespaces, channelObjects } = bindings;
	const findings = [];
	const lineOf = (node) =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

	const visit = (node) => {
		if (ts.isElementAccessExpression(node) && staticMemberName(node) === null) {
			const base = unwrap(node.expression);
			if (
				ts.isIdentifier(base) &&
				(channelNamespaces.has(base.text) || channelObjects.has(base.text))
			) {
				findings.push({
					file,
					line: lineOf(node),
					name: `${base.text}[…]`,
					reason:
						'a member of a module or object that carries a GraphQL transport is selected by a ' +
						'computed key, so this reader cannot tell whether the call is a transport call. ' +
						'An undecidable channel is a finding, not a skip.',
				});
			}
		}

		if (ts.isIdentifier(node) && names.has(node.text)) {
			const parent = node.parent;
			const isCallee = parent && ts.isCallExpression(parent) && unwrap(parent.expression) === node;
			const isDeclarationName =
				parent &&
				(ts.isVariableDeclaration(parent) ||
					ts.isImportSpecifier(parent) ||
					ts.isImportClause(parent) ||
					ts.isNamespaceImport(parent) ||
					ts.isExportSpecifier(parent) ||
					ts.isParameter(parent) ||
					ts.isBindingElement(parent) ||
					ts.isPropertyAssignment(parent) ||
					ts.isShorthandPropertyAssignment(parent) ||
					ts.isFunctionDeclaration(parent));
			const isAliasInitializer =
				parent && ts.isVariableDeclaration(parent) && parent.initializer === node;
			const isMemberBase =
				parent &&
				(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
				parent.expression === node;

			if (!isCallee && !isDeclarationName && !isAliasInitializer && !isMemberBase) {
				findings.push({
					file,
					line: lineOf(node),
					name: node.text,
					reason:
						`\`${node.text}\` is a GraphQL transport, and here it is used as a value rather ` +
						'than called. This reader cannot follow where it is invoked, so the documents it ' +
						'sends are unknown — which is a finding rather than an absence.',
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return findings;
}
