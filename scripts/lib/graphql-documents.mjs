/**
 * Reader: every GraphQL executable document contentus's source declares.
 *
 * This module answers one question — "what GraphQL text does this repository
 * actually send?" — and it answers it by PARSING, never by matching. The
 * documents here are template literals stitched from field fragments
 * (`${ARTICLE_SUMMARY_FIELDS}`), so the string a reviewer reads in the source is
 * not the string lesser receives. A reader that only looked at literal chunks
 * would validate text that is never sent and miss text that always is.
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT, each one a place a document could hide
 * from a gate written less suspiciously:
 *
 *   1. FOLDING, IN THE SCOPE THAT OWNS THE NAME. A document is only known once
 *      its interpolations are resolved, and an interpolation must be resolved
 *      where it was WRITTEN. `ARTICLES_INDEX_QUERY` imported into `loaders.ts`
 *      interpolates `ARTICLE_SUMMARY_FIELDS`, which exists only in `queries.ts`;
 *      folding it against the importer's scope yields nothing and quietly loses
 *      the document. So imported constants are folded to a STRING in their
 *      defining module and carried across as text.
 *
 *   2. UNCERTAINTY IS NOT ABSENCE. An interpolation that cannot be resolved does
 *      not become a best-effort string: it is returned as UNRESOLVED, and the
 *      gate treats that as a failure. "I could not determine what this sends"
 *      must never read the same as "this is fine".
 *
 *   3. DISCOVERY, NOT SELECTION. Every string- and template-valued expression in
 *      the file is folded and offered to the GraphQL parser. Membership is
 *      decided by `graphql.parse` succeeding on an executable definition, not by
 *      a naming convention: a document assigned to `const x` is as executable as
 *      one assigned to `const ARTICLES_QUERY`, and a reader keyed on
 *      SCREAMING_CASE would be a convention masquerading as coverage.
 *
 *   4. CANDIDATES THAT DO NOT PARSE. A template shaped like a document but
 *      failing to parse is reported as MALFORMED rather than skipped. The
 *      alternative — "it did not parse, so it is not a document" — is the exact
 *      shape of a fail-open: a broken document is precisely the thing worth
 *      catching, and it is the one case where "not a document" and "a document
 *      with a syntax error" look identical to a lenient reader.
 *
 * Field-fragment constants (`id\nusername\ndisplayName`) are not documents and
 * are not reported as such — they have no executable definition, and they are
 * validated where it counts: inside the operations that interpolate them.
 */
import { parse } from 'graphql';
import ts from 'typescript';

import {
	callMatchesAnySlot,
	declaredNames,
	documentSlot,
	documentSlotIn,
	enclosingNamedFunction,
	functionsIn,
	unfollowableChannelUses,
	writtenCalleeName,
} from './transport-channels.mjs';

/** Extensions whose contents are parsed as TypeScript/JavaScript source. */
export const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** How far an imported fragment is followed before the reader gives up and fails closed. */
const MAX_IMPORT_DEPTH = 8;

/**
 * A folded expression is a document candidate when its text names a GraphQL
 * operation or fragment in a spelling the grammar would accept.
 *
 * ANCHORED ON WHAT FOLLOWS THE NAME, not merely on the keyword. `query` is an
 * ordinary English word, and this repository writes user-facing sentences like
 * "The agent query could not be completed." A pattern keyed on the keyword alone
 * reported that string as a malformed document — a false positive that costs
 * exactly as much credibility as a miss, because the pressure it creates is to
 * loosen the gate. An operation is a keyword, then a name, then variable
 * definitions, a directive, or a selection set; nothing else is a definition,
 * and prose never reaches the third token.
 *
 * WHAT THIS RULE DELIBERATELY DOES NOT COVER, and why that is not a hole. An
 * anonymous document is a bare selection set (`{ articles { id } }`), which has
 * no keyword to anchor on and no shape distinguishing it from a CSS block, a
 * JSON fragment, or a design-token record — this repository has hundreds of
 * string literals that open with `{`, and screening them by shape produced pure
 * noise. Bare selection sets are admitted two other ways instead:
 *
 *   - `parsesAsDocument`: a bare `{...}` the GraphQL parser accepts as an
 *     executable definition is a document, whatever it was meant to be. This
 *     direction over-includes safely — being valid GraphQL is all it asserts.
 *   - `EXECUTOR_SITES`: anything actually handed to a GraphQL transport must
 *     fold, parse, and validate, with no shape test involved. That is the
 *     fail-closed half, and it is keyed on the channel's name rather than on the
 *     value's appearance, because a malformed anonymous document is exactly the
 *     case a shape test cannot see and an executor site always can.
 */
const NAMED_OPERATION =
	/(^|[\s;(,=[{])(query|mutation|subscription)\s+[A-Za-z_][A-Za-z_0-9]*\s*[({@]/;
const ANONYMOUS_OPERATION = /(^|[\s;(,=[{])(query|mutation|subscription)\s*[({]/;
const FRAGMENT_DEFINITION = /(^|[\s;(,=[{])fragment\s+[A-Za-z_][A-Za-z_0-9]*\s+on\s+[A-Za-z_]/;

function looksLikeDocument(text) {
	const trimmed = text.trim();
	return (
		NAMED_OPERATION.test(trimmed) ||
		ANONYMOUS_OPERATION.test(trimmed) ||
		FRAGMENT_DEFINITION.test(trimmed)
	);
}

function executableDefinitions(ast) {
	return ast.definitions.some(
		(definition) =>
			definition.kind === 'OperationDefinition' || definition.kind === 'FragmentDefinition'
	);
}

/** A bare selection set the GraphQL parser accepts as executable. */
function parsesAsDocument(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
	try {
		return executableDefinitions(parse(trimmed));
	} catch {
		return false;
	}
}

/**
 * Where a GraphQL document is HANDED TO A TRANSPORT.
 *
 * This used to be a table of NAMES compared against the identifier at a call
 * site, and the adversarial review sent documents past it four ways — an import
 * alias, a variable alias, a bracket property, and a `subscribe` alias — none of
 * them exotic. A name is not a channel. The question is answered by
 * `scripts/lib/transport-channels.mjs` now, which roots the analysis at the
 * transport EXPORTS (`src/lib/cms/graphql.ts#graphqlRequest`,
 * `src/lib/timelines/subscription.ts#subscribe`) and follows the module graph out
 * to every local name that refers to them, wrappers included.
 *
 * Re-exported here so the roots have one import path across the gate and its
 * tests, and so `tests/graphql-contract.test.mjs` can assert each root really is
 * an export of the module it names.
 */
export { TRANSPORT_ROOTS } from './transport-channels.mjs';

function scriptKind(file) {
	if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
	if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
	if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs'))
		return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

export function parseSource(file, source) {
	return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
}

/**
 * Every `const NAME = <expression>` binding at any scope in the file.
 *
 * Deliberately flat rather than lexically scoped: this reader wants the widest
 * set of resolvable names, because an interpolation it CANNOT resolve becomes a
 * gate failure. Two bindings sharing a name are recorded as unresolvable rather
 * than guessed at — which one an interpolation meant is not decidable here, and
 * picking either would pin a document the code may never send.
 */
function bindingsIn(sourceFile) {
	const scope = new Map();
	const collide = new Set();

	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const name = node.name.text;
			if (collide.has(name)) {
				// already undecidable
			} else if (scope.has(name)) {
				collide.add(name);
				scope.delete(name);
			} else {
				scope.set(name, node.initializer);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return scope;
}

/**
 * Value-carrying named imports, as `local -> { module, exported }`.
 * Type-only imports are excluded: they carry no value and can never be
 * interpolated into a document.
 */
function importsIn(sourceFile) {
	const imports = new Map();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!statement.importClause || statement.importClause.isTypeOnly) continue;
		const bindings = statement.importClause.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		for (const element of bindings.elements) {
			if (element.isTypeOnly) continue;
			imports.set(element.name.text, {
				module: statement.moduleSpecifier.text,
				exported: (element.propertyName ?? element.name).text,
			});
		}
	}
	return imports;
}

/** `export { X } from './y'` — a name this module publishes but does not define. */
function reExportsIn(sourceFile) {
	const reExports = new Map();
	for (const statement of sourceFile.statements) {
		if (!ts.isExportDeclaration(statement)) continue;
		if (statement.isTypeOnly) continue;
		if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
		for (const element of statement.exportClause.elements) {
			if (element.isTypeOnly) continue;
			reExports.set(element.name.text, {
				module: statement.moduleSpecifier.text,
				exported: (element.propertyName ?? element.name).text,
			});
		}
	}
	return reExports;
}

/** Exported `const` initializers of a parsed module. */
function exportedInitializers(sourceFile) {
	const exported = new Map();
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		const isExported = statement.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
		);
		if (!isExported) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer) {
				exported.set(declaration.name.text, declaration.initializer);
			}
		}
	}
	return exported;
}

/**
 * A module's scope: local `const` initializers plus every imported constant
 * already folded to text IN THE MODULE THAT DEFINES IT.
 *
 * The second half is the whole point. Carrying an imported AST node across and
 * folding it here would resolve its interpolations against the wrong file's
 * bindings, which is not a near-miss — it silently turns a real document into an
 * unresolved one, and a gate that then skipped it would be reporting green over
 * the query this repository sends most often.
 */
function moduleScope(file, source, resolveImport, depth, cache) {
	const cached = cache.get(file);
	if (cached) return cached;

	const sourceFile = parseSource(file, source);
	const scope = { nodes: bindingsIn(sourceFile), literals: new Map(), sourceFile };
	cache.set(file, scope);

	if (depth >= MAX_IMPORT_DEPTH) return scope;

	for (const [local, origin] of importsIn(sourceFile)) {
		if (scope.nodes.has(local)) continue;
		const value = importedLiteral(origin, file, resolveImport, depth + 1, cache);
		if (value !== null) scope.literals.set(local, value);
	}

	return scope;
}

/**
 * Folded text of `origin.exported` as its defining module sees it, or `null`
 * when the module is external, missing, or the export is not a foldable const.
 */
function importedLiteral(origin, fromFile, resolveImport, depth, cache) {
	if (depth > MAX_IMPORT_DEPTH) return null;
	const resolved = resolveImport(origin.module, fromFile);
	if (!resolved) return null;

	const targetScope = moduleScope(resolved.file, resolved.source, resolveImport, depth, cache);
	const initializer = exportedInitializers(targetScope.sourceFile).get(origin.exported);
	if (initializer !== undefined) {
		return foldExpression(initializer, targetScope, new Set());
	}

	// `export { X } from './y'` — the name is published here but defined further
	// along. Following it keeps a re-export barrel from hiding a document.
	const reExport = reExportsIn(targetScope.sourceFile).get(origin.exported);
	if (reExport) {
		return importedLiteral(reExport, resolved.file, resolveImport, depth + 1, cache);
	}

	return null;
}

/**
 * Static string value of an expression, or `null` when it cannot be determined.
 *
 * `null` is load-bearing. It is the reader saying "this expression's value is
 * not decidable from source", and every caller must treat it as an unresolved
 * document rather than as an absent one.
 */
function foldExpression(node, scope, seen) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return node.text;
	}

	if (ts.isTemplateExpression(node)) {
		let out = node.head.text;
		for (const span of node.templateSpans) {
			const value = foldExpression(span.expression, scope, seen);
			if (value === null) return null;
			out += value + span.literal.text;
		}
		return out;
	}

	if (ts.isIdentifier(node)) {
		const key = node.text;
		const literal = scope.literals.get(key);
		if (literal !== undefined) return literal;
		// A binding already on the resolution stack is a cycle; refusing to
		// unfold it is the only answer that terminates, and a cyclic fragment is
		// not a document this repository can send anyway.
		if (seen.has(key)) return null;
		const target = scope.nodes.get(key);
		if (target === undefined) return null;
		seen.add(key);
		try {
			return foldExpression(target, scope, seen);
		} finally {
			seen.delete(key);
		}
	}

	if (ts.isParenthesizedExpression(node)) return foldExpression(node.expression, scope, seen);
	if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
		return foldExpression(node.expression, scope, seen);
	}
	if (ts.isNonNullExpression(node)) return foldExpression(node.expression, scope, seen);

	// String concatenation is a documented way to build a document, so it folds
	// too — but only when BOTH sides fold. A half-known string is unknown.
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = foldExpression(node.left, scope, seen);
		if (left === null) return null;
		const right = foldExpression(node.right, scope, seen);
		if (right === null) return null;
		return left + right;
	}

	// A conditional picks one of two documents at runtime; both are sent, so
	// both are reported. The caller receives them as separate candidates.
	if (ts.isConditionalExpression(node)) {
		const whenTrue = foldExpression(node.whenTrue, scope, seen);
		const whenFalse = foldExpression(node.whenFalse, scope, seen);
		if (whenTrue === null || whenFalse === null) return null;
		return whenTrue === whenFalse ? whenTrue : null;
	}

	return null;
}

/**
 * Both arms of a conditional, so a branch-selected document is not lost.
 *
 * Resolves through local `const` bindings, because the repository writes the
 * choice one line above the call:
 *
 *     const query = kind === 'series' ? SERIES_BY_SLUG_QUERY : CATEGORY_BY_SLUG_QUERY;
 *     graphqlRequest(query, ...)
 *
 * Splitting only at the call site would fold `query` to `null` — two different
 * documents are sent, so no single value is correct — and report an unresolved
 * executor site for code that is perfectly determinate. Both documents are real
 * and both get validated.
 */
function branches(node, scope, seen = new Set()) {
	if (ts.isParenthesizedExpression(node)) return branches(node.expression, scope, seen);
	if (ts.isConditionalExpression(node)) {
		return [...branches(node.whenTrue, scope, seen), ...branches(node.whenFalse, scope, seen)];
	}
	if (scope && ts.isIdentifier(node) && !seen.has(node.text)) {
		const target = scope.nodes.get(node.text);
		if (target && ts.isConditionalExpression(target)) {
			seen.add(node.text);
			return branches(target, scope, seen);
		}
	}
	return [node];
}

/** Literal (non-interpolated) text chunks of an expression, for candidate screening. */
function literalChunks(node) {
	const chunks = [];
	const visit = (current) => {
		if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
			chunks.push(current.text);
		} else if (ts.isTemplateExpression(current)) {
			chunks.push(current.head.text);
			for (const span of current.templateSpans) chunks.push(span.literal.text);
		}
		ts.forEachChild(current, visit);
	};
	visit(node);
	return chunks;
}

/**
 * Every GraphQL document a source file declares.
 *
 * `resolveImport(specifier, fromFile)` is supplied by the caller and returns
 * `{ file, source }` for a relative/aliased module, or `null` when the module is
 * external. Resolution belongs to the caller because the caller owns the alias
 * table and the on-disk layout; inventing either here would pin a file that
 * never runs.
 *
 * `channels` is the transport graph from `buildChannelGraph`, which decides which
 * calls are transport calls BY PROVENANCE rather than by the name written at the
 * site. Omitting it leaves only pass 2's shape screen, which cannot see a
 * dynamically assembled anonymous document — so the gate always builds one, and
 * `tests/graphql-contract.test.mjs` proves each alias bypass is red with it.
 *
 * Returns `{ documents, unresolved, malformed }`. `unresolved` and `malformed`
 * are failures, not diagnostics — see the gate.
 */
export function documentsIn(file, source, resolveImport = () => null, channels = null) {
	const cache = new Map();
	const scope = moduleScope(file, source, resolveImport, 0, cache);
	const { sourceFile } = scope;

	const documents = [];
	const unresolved = [];
	const malformed = [];
	const seenSites = new Set();
	const lineOf = (node) =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

	/**
	 * @param node       expression to fold
	 * @param name       reporting label
	 * @param byChannel  true when the expression reached a GraphQL transport, in
	 *                   which case it is a document by provenance and every
	 *                   uncertainty about it is a finding
	 */
	const consider = (node, name, byChannel = false) => {
		const site = node.getStart(sourceFile);
		if (seenSites.has(site)) return;

		const folded = foldExpression(node, scope, new Set());

		if (folded === null) {
			if (byChannel || literalChunks(node).some(looksLikeDocument)) {
				seenSites.add(site);
				unresolved.push({ name, line: lineOf(node), file, byChannel });
			}
			return;
		}

		if (!byChannel && !looksLikeDocument(folded) && !parsesAsDocument(folded)) return;
		seenSites.add(site);

		try {
			const ast = parse(folded);
			if (executableDefinitions(ast)) {
				documents.push({ name, text: folded, line: lineOf(node), file, byChannel });
			} else if (byChannel) {
				malformed.push({
					name,
					line: lineOf(node),
					file,
					byChannel,
					reason: 'reaches a GraphQL transport but declares no executable operation',
				});
			}
		} catch (error) {
			malformed.push({ name, line: lineOf(node), file, byChannel, reason: error.message });
		}
	};

	// Pass 1 — transport channels, resolved by provenance.
	//
	// Walked first so a document reaching a transport is recorded by provenance
	// even when its text would not have survived the shape test in pass 2.
	// Conditional arguments are split, because a channel called as
	// `send(a ? X : Y, ...)` sends both X and Y.
	//
	// WHICH CALLS ARE CHANNELS is decided by `channels`, built once across the
	// whole file set: it has already followed import aliases, re-exports, variable
	// aliases, namespace and object members, and wrapper functions out from the
	// transport EXPORTS. A caller that hands no graph gets pass 2 only, which is
	// why the gate always builds one.
	const bindings = channels?.bindingsFor(file) ?? null;
	// Built from THIS walk's AST. The channel graph's own map holds nodes from a
	// different parse, and node identity does not cross between them; only names do.
	const functions = functionsIn(sourceFile);

	/** Is this expression a parameter of a function that is itself a channel? */
	const coveredByWrapper = (node) => {
		if (!ts.isIdentifier(node) || !bindings) return false;
		const enclosing = enclosingNamedFunction(node, functions);
		if (!enclosing) return false;
		if (enclosing.entry.parameters.indexOf(node.text) < 0) return false;
		// The wrapper is a channel, so its own call sites carry the real document
		// and are checked there — in this file or, for an exported wrapper, in
		// whichever file calls it. Reporting here would accuse the forwarder of
		// the caller's job. A parameter of a function that is NOT a channel is a
		// different thing entirely and still reports.
		return Boolean(
			bindings.names.get(enclosing.name) ?? channels.exportedChannels(file).get(enclosing.name)
		);
	};

	const considerChannel = (node, label) => {
		if (coveredByWrapper(node)) return;
		consider(node, label, true);
	};

	const visitSites = (node) => {
		if (ts.isCallExpression(node)) {
			// THREE OUTCOMES, and the middle one is the repair. `callAt` answers with a
			// transport call, with an UNDECIDABLE call it could not follow, or with
			// null — and null now means "positively not a transport" rather than "I
			// have not been taught this form". `.call`, `.apply`, `.bind`, a spread
			// argument list and a computed receiver each used to arrive here as null.
			const outcome = channels?.callAt(file, node) ?? null;
			if (outcome?.undecidable) {
				malformed.push({
					name: `${writtenCalleeName(node.expression) ?? '<channel>'}(…)`,
					line: lineOf(node),
					file,
					byChannel: true,
					reason: outcome.undecidable.reason,
				});
			} else if (outcome) {
				const { spec, args, via } = outcome;
				const slot = documentSlotIn(args, spec);
				if (slot) {
					// NAMED BY THE TRANSPORT, not by the method. `graphqlRequest.call(…)`
					// is written with `call` at the call position, and labelling the
					// finding `call → arg 0` would hide which transport was resolved —
					// which is the one thing a reader of this finding needs to know.
					const label = `${via ?? writtenCalleeName(node.expression) ?? '<channel>'} → ${
						typeof spec.argument === 'number' ? `arg ${spec.argument}` : `{ ${spec.property} }`
					}`;
					for (const arm of branches(slot, scope)) considerChannel(arm, label);
				}
			} else {
				// THE NAME-KEYED BACKSTOP. Provenance said nothing, but the call is
				// WRITTEN with a channel's name and carries that channel's document
				// slot — `getTransport().graphqlRequest(document)`. Silence there
				// would be permission, so it reports as unreadable.
				//
				// NARROWED TWICE, because a backstop that fires on correct code is
				// the pressure that gets gates loosened. By the SLOT, so it cannot
				// accuse this tree's store and push-manager `subscribe` methods,
				// which carry no `query`. And by the RECEIVER: a bare identifier the
				// file itself declares is not an unfollowable receiver — provenance
				// answered it, and the answer was "not the transport".
				const written = writtenCalleeName(node.expression);
				const callee = node.expression;
				const receiverIsFollowed =
					ts.isIdentifier(callee) && declaredNames(sourceFile).has(callee.text);
				const specs =
					written && !receiverIsFollowed ? (channels?.specsByName.get(written) ?? null) : null;
				if (specs && callMatchesAnySlot(node, specs)) {
					const slot = specs.map((candidate) => documentSlot(node, candidate)).find(Boolean);
					if (slot && !coveredByWrapper(slot)) {
						unresolved.push({
							name: `${written}(…) — receiver not resolved to a transport`,
							line: lineOf(node),
							file,
							byChannel: true,
						});
					}
				}
			}
		}
		ts.forEachChild(node, visitSites);
	};
	visitSites(sourceFile);

	// Channel references this reading could not follow at all — a computed member
	// of something carrying a transport, or a transport used as a value rather
	// than called. Both are places a document could reach lesser unseen.
	if (bindings) {
		for (const finding of unfollowableChannelUses(file, bindings)) malformed.push(finding);
	}

	// Pass 2 — declarations and inline literals anywhere in the file.
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			consider(node.initializer, node.name.text);
		} else if (
			ts.isTemplateExpression(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isStringLiteral(node)
		) {
			// A document returned, or stored in a property, never reaches a
			// `const` name. Those sites are considered on their own so the reader
			// is not keyed on assignment shape.
			const parent = node.parent;
			const declared = parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name);
			if (!declared) consider(node, `<inline@${lineOf(node)}>`);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return { documents, unresolved, malformed };
}
