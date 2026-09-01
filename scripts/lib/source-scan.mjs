/**
 * Owned-source reading for the renderer-authority audit, driven by the SAME
 * parsers the toolchain runs — the Svelte compiler for `.svelte` templates and
 * TypeScript for script text — rather than by comment-stripped regexes.
 *
 * WHY THIS MODULE EXISTS, REPLACING THE STRIPPER AT THE SINK SURFACE. Round-1
 * adversarial review of the #112 renderer-authority gate found three live
 * bypasses, all of them properties of scanning text with comments removed:
 *
 *   A. `/*` inside a quoted template expression (`{'/*'}`) was read as a
 *      comment opener, hiding a second, computed `{@html}` sink between the
 *      planted delimiters.
 *   B. a script-side reassignment of `preview.html` before the verbatim sink
 *      passed a binding that only counted sinks and checked the sink's text.
 *   C. alternate raw-HTML sinks (`el.innerHTML = …`, `<iframe srcdoc=…>`,
 *      `insertAdjacentHTML`, `document.write`) were not scanned at all.
 *
 * A parser does not have these failure modes. The Svelte compiler decides what
 * is a comment, what is a string, and what is a live `{@html}` tag; TypeScript
 * decides what is an assignment and what is a method call. Comments are trivia
 * in both, so the old comment/string trade-offs (stripping concatenates tokens;
 * not stripping false-positives on prose) simply stop being made here.
 *
 * FAIL-CLOSED ON UNPARSEABLE SOURCE. Every function throws when the compiler or
 * parser cannot read its input; the audit converts a throw into a finding. A
 * file the toolchain cannot parse is a file whose sinks this gate cannot see,
 * and silence over it is the exact failure the round-1 report demonstrated.
 *
 * THE ONE COPY. The audit imports this module, and the probes drive the audit;
 * a second definition of any scan here would be free to drift from the gate.
 */

import { parse } from 'svelte/compiler';
import ts from 'typescript';

/**
 * The Svelte component parsed the way the toolchain parses it (modern AST,
 * `svelte/compiler` `parse`). Throws with the file named when the compiler
 * cannot read the component — unreadable is a finding, never an empty scan.
 */
export function parseSvelte(file, source) {
	try {
		return parse(source, { modern: true, filename: file });
	} catch (error) {
		throw new Error(
			`${file}: the Svelte compiler cannot parse this component, so its HTML sinks cannot be ` +
				`read — ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
}

/**
 * Every `{@html …}` sink in a component, as the compiler's `HtmlTag` nodes.
 *
 * `HtmlTag` is the modern-AST node type for the `{@html}` tag. Comments and
 * strings never produce one — that is the entire content of bypass A above.
 */
export function svelteHtmlTags(file, source) {
	const ast = parseSvelte(file, source);
	const tags = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'HtmlTag') tags.push(node);
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visit(node[key]);
		}
	};
	visit(ast.fragment);
	return tags;
}

/**
 * Every element carrying a `srcdoc` attribute — an alternate raw-HTML sink
 * (bypass C's `srcdoc` half) that `{@html}` scanning never sees. Matched
 * case-insensitively: HTML attribute names are case-insensitive, so
 * `<iframe SRCDOC=…>` and `<iframe srcDoc=…>` are the same sink as
 * `<iframe srcdoc=…>` (round-5), and the compiler preserves the written
 * case in `attribute.name`.
 */
export function svelteSrcdoc(file, source) {
	const ast = parseSvelte(file, source);
	const findings = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
			for (const attribute of node.attributes ?? []) {
				if (attribute.type === 'Attribute' && attribute.name.toLowerCase() === 'srcdoc') {
					findings.push(`<${node.name} srcdoc=…> renders raw HTML`);
				}
			}
		}
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visit(node[key]);
		}
	};
	visit(ast.fragment);
	return findings;
}

/**
 * The component's `<script>` block texts (module and instance), taken from the
 * compiler's own parse — the compiler, not a tag regex, decides where a script
 * begins and ends. Each block carries its `context` (`'module'` or `'default'`)
 * so a single `<script>` is recognized as the instance script it is.
 */
export function svelteScriptContents(file, source) {
	const ast = parseSvelte(file, source);
	return [ast.module, ast.instance].filter(Boolean).map((block) => ({
		text: source.slice(block.content.start, block.content.end),
		context: block.context,
	}));
}

/**
 * `{@const …}` tags in markup. A markup-declared binding can shadow the
 * component's `preview` prop, which would let `{@html preview.html}` display a
 * value that is no longer the prop — the display sink must read the prop
 * directly, so the pinned component carries none.
 */
export function svelteConstTags(file, source) {
	const ast = parseSvelte(file, source);
	const tags = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'ConstTag') tags.push(node);
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visit(node[key]);
		}
	};
	visit(ast.fragment);
	return tags;
}

/**
 * Script text parsed as TypeScript — a superset of every dialect this
 * repository writes. Throws with the file named when the source does not
 * parse; a recovered parse is not a reading this gate accepts.
 */
export function parseTypeScript(source, { file = 'probe.ts', jsx = false } = {}) {
	const sourceFile = ts.createSourceFile(
		jsx ? 'probe.tsx' : 'probe.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	if (!Array.isArray(sourceFile.parseDiagnostics))
		throw new Error(
			`${file}: the TypeScript parser no longer reports parse diagnostics under ` +
				'`parseDiagnostics`; this scan cannot tell a clean parse from a recovered one'
		);
	if (sourceFile.parseDiagnostics.length)
		throw new Error(
			`${file}: this source does not parse as TypeScript, so its sinks cannot be read — ` +
				ts.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, ' ')
		);
	return sourceFile;
}

/** Depth-first over every node in a TypeScript source file. */
export function eachNode(node, visit) {
	visit(node);
	ts.forEachChild(node, (child) => eachNode(child, visit));
}

const RAW_HTML_PROPERTY = new Set([
	'innerHTML',
	'outerHTML',
	'insertAdjacentHTML',
	'srcdoc',
	'write',
	'writeln',
]);

/**
 * Properties a WRITE can turn into a raw-HTML sink. `insertAdjacentHTML`,
 * `write` and `writeln` are call-only sinks; assigning to them replaces a
 * method and is not an injection. `srcdoc` is the round-2 addition: a
 * script-side `frame.srcdoc = html` writes an HTML document into an iframe
 * just as directly as `el.innerHTML = html` writes one into an element.
 */
const RAW_HTML_WRITE_PROPERTY = new Set(['innerHTML', 'outerHTML', 'srcdoc']);

/**
 * Constant-fold a property-key expression to the literal text it names, or null.
 *
 * String literals and no-substitution templates fold to their text; a binary
 * `+` of two foldable operands folds to their concatenation, so
 * `el['inner' + 'HTML']` resolves to the same key the literal spelling does.
 * Anything else — an identifier, a call, a conditional — is a key this reading
 * cannot resolve, and the sink scans treat that as COMPUTED rather than safe
 * (round-2 evasion: computed element/member access to a dangerous sink).
 */
function foldPropertyKey(node) {
	if (!node) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = foldPropertyKey(node.left);
		const right = foldPropertyKey(node.right);
		if (left !== null && right !== null) return left + right;
	}
	return null;
}

/**
 * The name an access expression reads or writes, when the shape is readable.
 *
 * `{ name, object, computed }`: a property access carries its name; an element
 * access carries its folded key when one exists. `computed` is true only for an
 * element access whose key does not fold — `el[key]` where `key` is a runtime
 * value — and a computed position is never silently cleared: the caller either
 * fails closed on it or does not claim to have read the position.
 */
function propertyName(node) {
	if (ts.isPropertyAccessExpression(node)) {
		return { name: node.name.text, object: node.expression, computed: false };
	}
	if (ts.isElementAccessExpression(node)) {
		const folded = foldPropertyKey(node.argumentExpression);
		if (folded !== null) return { name: folded, object: node.expression, computed: false };
		return { name: null, object: node.expression, computed: true };
	}
	return null;
}

function objectNames(node, out = new Set()) {
	if (!node) return out;
	if (ts.isIdentifier(node)) out.add(node.text);
	if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
		objectNames(node.expression, out);
	}
	return out;
}

/**
 * Whether a node is a document object: the `document` identifier, or an access
 * whose chain ends in a `document` name — `window.document`,
 * `globalThis.document`, `printWindow.document`. The round-2 probe bound an
 * alias from `globalThis.document`, so the property NAME matters as much as
 * the base identifier: a names-only reading of that chain saw `globalThis`
 * and nothing else.
 */
function isDocumentObject(node) {
	if (!node) return false;
	if (ts.isIdentifier(node)) return node.text === 'document';
	if (ts.isPropertyAccessExpression(node)) {
		return node.name.text === 'document' || isDocumentObject(node.expression);
	}
	if (ts.isElementAccessExpression(node)) {
		const folded = foldPropertyKey(node.argumentExpression);
		return folded === 'document' || isDocumentObject(node.expression);
	}
	return false;
}

/**
 * Alternate raw-HTML sink sites in script text (bypass C's script half,
 * strengthened against the round-2 evasion shapes):
 *
 *   - assignments to `.innerHTML` / `.outerHTML` / `.srcdoc` (also compound
 *     and update forms, also the element-access spelling, also a key that
 *     constant-folds to one, e.g. `el['inner' + 'HTML']`);
 *   - an assignment, mutation or call through a COMPUTED key (`el[key] = …`,
 *     `el[key](…)`) — a key no static read can fold could name any of the
 *     dangerous properties, so the position fails closed;
 *   - calls to `.insertAdjacentHTML(…)` and `.createContextualFragment(…)`;
 *   - calls to `document.write(…)` / `document.writeln(…)`, including through
 *     a locally bound alias (`const d = globalThis.document; d.write(…)`), and
 *     `.write(…)` on a receiver this reading cannot prove is not a document;
 *   - `Reflect.set(receiver, key, …)` with a dangerous or computed key;
 *   - `Object.assign(receiver, { … })` whose source object carries a dangerous
 *     key, or whose receiver is the document object;
 *   - JSX spread attributes onto an `<iframe>` (a spread can set `srcdoc`).
 *
 * Returns findings already prefixed with the file path. This is a syntax-tree
 * reading: strings and comments never become nodes, so prose naming a sink is
 * not a finding and a sink hidden in a string is not missed.
 */
export function alternateSinksInScript(file, source, { jsx = false } = {}) {
	const sourceFile = parseTypeScript(source, { file, jsx });
	const findings = [];

	const isAssignmentToken = (kind) =>
		kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

	// --- container receivers, collected before the sink walk -------------------
	// A computed WRITE is only a raw-HTML threat when the receiver could be a
	// DOM element: `el[key] = html` with `key === 'innerHTML'` injects, while
	// `headers[lower] = value` on a plain object does not, however the key
	// folds. So the fail-closed rule is scoped to receivers this reading cannot
	// prove non-DOM: local names bound from an object/array literal,
	// `Object.create`/`Object.fromEntries`, or a container constructor
	// (`Map`, `Headers`, `URLSearchParams`, …). A receiver bound from a call,
	// a member access, or a function parameter is NOT cleared — it could be an
	// element, and the round-2 probes plant exactly that shape.
	const CONTAINER_CONSTRUCTORS = new Set([
		'Array',
		'Map',
		'Set',
		'WeakMap',
		'WeakSet',
		'Headers',
		'URLSearchParams',
		'FormData',
		'URL',
		'Blob',
		'File',
		'AbortController',
		'AbortSignal',
	]);
	const isContainerExpression = (node) => {
		if (!node) return false;
		if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return true;
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression))
			return CONTAINER_CONSTRUCTORS.has(node.expression.text);
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'Object' &&
			(node.expression.name.text === 'create' || node.expression.name.text === 'fromEntries')
		)
			return true;
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === '$state' &&
			node.arguments.length === 1 &&
			(ts.isObjectLiteralExpression(node.arguments[0]) ||
				ts.isArrayLiteralExpression(node.arguments[0]))
		)
			return true;
		// R5-5: `$state.raw(<object/array literal>)` is the same legitimate
		// container — a plain, non-reactive object whose computed writes are
		// ordinary object writes. The round-5 review found it false-failing
		// because the rune's `raw` form names the property access `$state.raw`,
		// which the identifier-only spelling above does not see.
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === '$state' &&
			node.expression.name.text === 'raw' &&
			node.arguments.length === 1 &&
			(ts.isObjectLiteralExpression(node.arguments[0]) ||
				ts.isArrayLiteralExpression(node.arguments[0]))
		)
			return true;
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'JSON' &&
			node.expression.name.text === 'parse'
		)
			return true;
		return false;
	};
	const containerReceivers = new Set();
	eachNode(sourceFile, (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			isContainerExpression(node.initializer)
		)
			containerReceivers.add(node.name.text);
	});
	const receiverCleared = (receiver) =>
		ts.isIdentifier(receiver) && containerReceivers.has(receiver.text);

	// --- document aliases, collected before the sink walk ---------------------
	// `const d = globalThis.document;` and `d = window.document;` make `d` a
	// document object for the rest of the file, and `d.write(…)` is a
	// `document.write(…)` that a names-only reading would clear. The alias table
	// is local: declarations and assignments whose right side is itself a
	// document-object expression, which is the shape the round-2 probe planted.
	const documentAliases = new Set();
	eachNode(sourceFile, (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer && isDocumentObject(node.initializer)) {
			if (ts.isIdentifier(node.name)) documentAliases.add(node.name.text);
		}
		if (
			ts.isBinaryExpression(node) &&
			isAssignmentToken(node.operatorToken.kind) &&
			ts.isIdentifier(node.left) &&
			isDocumentObject(node.right)
		) {
			documentAliases.add(node.left.text);
		}
	});
	const isDocumentish = (names) =>
		names.has('document') || [...names].some((name) => documentAliases.has(name));
	const dangerousMethodAliases = new Map();
	const constantStrings = new Map();
	const dangerousMethodName = (node) => {
		const access = propertyName(node);
		if (!access || access.computed) return null;
		return [
			'write',
			'writeln',
			'insertAdjacentHTML',
			'createContextualFragment',
			'parseFromString',
		].includes(access.name)
			? access.name
			: null;
	};
	eachNode(sourceFile, (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			if (ts.isIdentifier(node.name)) {
				const literal = foldPropertyKey(node.initializer);
				if (literal !== null) constantStrings.set(node.name.text, literal);
			}
			if (ts.isIdentifier(node.name)) {
				const method = dangerousMethodName(node.initializer);
				if (method) dangerousMethodAliases.set(node.name.text, method);
			}
			if (ts.isObjectBindingPattern(node.name)) {
				// R5-4: a destructured, RENAMED dangerous method — `const {
				// insertAdjacentHTML: inject } = document.body` — binds a local that
				// can be called with raw HTML, and the round-5 review planted it
				// because the write/writeln-only destructure reading did not see the
				// other dangerous methods. The receiver decides the verdict:
				//   - a document object (or a local alias of one) — the method IS
				//     the document's own, so the destructure is a finding;
				//   - a provable container — the object holds data, not DOM, so the
				//     binding is legitimate;
				//   - anything else — a DOM element, a parameter, a call result —
				//     cannot be proven non-DOM, so the position fails closed.
				const initializer = node.initializer;
				const receiverIsDocument = isDocumentObject(initializer);
				const receiverIsContainer =
					receiverCleared(initializer) || isContainerExpression(initializer);
				const receiverIsDocumentAlias =
					ts.isIdentifier(initializer) && documentAliases.has(initializer.text);
				const known = receiverIsDocument || receiverIsDocumentAlias;
				const unknown = !known && !receiverIsContainer;
				for (const element of node.name.elements) {
					const property = element.propertyName ?? element.name;
					const method = ts.isIdentifier(property) ? property.text : foldPropertyKey(property);
					if (method === null) {
						// A computed key (`const { [k]: inject } = document.body`)
						// could name any dangerous method, and the destructure is a
						// binding of whatever it is. Fail closed unless the receiver
						// is a provable container.
						if (!receiverIsContainer)
							findings.push(
								`${file} destructures a computed key off a receiver this reading cannot prove is not a DOM object — the key could name a raw-HTML method`
							);
						continue;
					}
					if (!['write', 'writeln', 'insertAdjacentHTML', 'createContextualFragment', 'parseFromString'].includes(method))
						continue;
					if (ts.isIdentifier(element.name))
						dangerousMethodAliases.set(element.name.text, method);
					if (known)
						findings.push(
							`${file} destructures .${method} off a document object — the method can be called with raw HTML`
						);
					else if (unknown)
						findings.push(
							`${file} destructures .${method} off a receiver this reading cannot prove is not a DOM object — the local can be called with raw HTML`
						);
				}
			}
		}
	});
	const foldLocalKey = (node) =>
		ts.isIdentifier(node) && constantStrings.has(node.text)
			? constantStrings.get(node.text)
			: foldPropertyKey(node);

	// R5-4: identifier-laundered OBJECT SOURCES. The Object.assign walk reads
	// dangerous keys out of object literals written at the call; `const payload
	// = { srcdoc: html }; Object.assign(frame, payload)` hides the key in a
	// name. This pre-pass records the folded keys of every object literal a
	// local name is bound to — through plain aliases and spreads, to a fixed
	// point — so the walk can see the dangerous key through the name.
	const objectLiteralKeys = new Map();
	{
		let grew = true;
		const adoptKeys = (name, keys) => {
			if (!objectLiteralKeys.has(name)) {
				objectLiteralKeys.set(name, new Set(keys));
				grew = true;
				return;
			}
			for (const key of keys) {
				if (!objectLiteralKeys.get(name).has(key)) {
					objectLiteralKeys.get(name).add(key);
					grew = true;
				}
			}
		};
		while (grew) {
			grew = false;
			eachNode(sourceFile, (node) => {
				let bound = null;
				let rhs = null;
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
					bound = node.name.text;
					rhs = node.initializer;
				} else if (
					ts.isBinaryExpression(node) &&
					node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					ts.isIdentifier(node.left)
				) {
					bound = node.left.text;
					rhs = node.right;
				}
				if (bound === null || !rhs) return;
				const inner = unwrapValueNode(rhs);
				if (ts.isIdentifier(inner) && objectLiteralKeys.has(inner.text)) {
					adoptKeys(bound, objectLiteralKeys.get(inner.text));
					return;
				}
				if (!ts.isObjectLiteralExpression(inner)) return;
				const keys = new Set();
				for (const property of inner.properties) {
					if (ts.isSpreadAssignment(property)) {
						const spread = unwrapValueNode(property.expression);
						if (ts.isIdentifier(spread) && objectLiteralKeys.has(spread.text)) {
							for (const key of objectLiteralKeys.get(spread.text)) keys.add(key);
						}
						continue;
					}
					let key = null;
					if (ts.isPropertyAssignment(property)) {
						key = ts.isComputedPropertyName(property.name)
							? foldPropertyKey(property.name.expression)
							: ts.isIdentifier(property.name)
								? property.name.text
								: ts.isStringLiteral(property.name)
									? property.name.text
									: null;
					} else if (ts.isShorthandPropertyAssignment(property)) {
						key = property.name.text;
					}
					if (key !== null) keys.add(key);
				}
				adoptKeys(bound, keys);
			});
		}
	}

	eachNode(sourceFile, (node) => {
		if (ts.isBinaryExpression(node)) {
			const operator = node.operatorToken.kind;
			if (!isAssignmentToken(operator)) return;
			const access = propertyName(node.left);
			if (access && access.computed) {
				if (!receiverCleared(access.object)) {
					findings.push(
						`${file} writes through a computed key (${node.left
							.getText(sourceFile)
							.slice(0, 60)}…) — a key no static read can fold could be 'innerHTML' or 'srcdoc'`
					);
				}
			} else if (access && RAW_HTML_WRITE_PROPERTY.has(access.name)) {
				findings.push(
					`${file} writes to .${access.name} — an alternate raw-HTML sink that bypasses {@html} scanning`
				);
			}
			return;
		}
		if (
			node.kind === ts.SyntaxKind.PrefixUnaryExpression ||
			node.kind === ts.SyntaxKind.PostfixUnaryExpression
		) {
			if (
				node.operator !== ts.SyntaxKind.PlusPlusToken &&
				node.operator !== ts.SyntaxKind.MinusMinusToken
			) {
				return;
			}
			const access = propertyName(node.operand);
			if (access && access.computed) {
				if (!receiverCleared(access.object)) {
					findings.push(
						`${file} mutates through a computed key — it could be a raw-HTML write property`
					);
				}
			} else if (access && RAW_HTML_WRITE_PROPERTY.has(access.name)) {
				findings.push(
					`${file} mutates .${access.name} — an alternate raw-HTML sink that bypasses {@html} scanning`
				);
			}
			return;
		}
		if (ts.isCallExpression(node)) {
			const callee = propertyName(node.expression);
			if (ts.isIdentifier(node.expression) && dangerousMethodAliases.has(node.expression.text)) {
				findings.push(
					`${file} calls an alias of .${dangerousMethodAliases.get(node.expression.text)}(…) — an alternate raw-HTML primitive`
				);
				return;
			}
			if (callee && callee.computed) {
				if (!receiverCleared(callee.object)) {
					findings.push(
						`${file} calls through a computed key (${node.expression
							.getText(sourceFile)
							.slice(0, 60)}…) — the method could be insertAdjacentHTML or a document write`
					);
				}
				return;
			}
			if (callee) {
				if (
					callee.name === 'insertAdjacentHTML' ||
					callee.name === 'createContextualFragment' ||
					callee.name === 'parseFromString'
				) {
					findings.push(
						`${file} calls .${callee.name}(…) — an alternate raw-HTML sink that bypasses {@html} scanning`
					);
					return;
				}
				if (callee.name === 'setAttribute' || callee.name === 'setAttributeNS') {
					const keyArgument = node.arguments[callee.name === 'setAttributeNS' ? 1 : 0];
					const key = foldLocalKey(keyArgument);
					// HTML attribute names are case-insensitive — `setAttribute(
					// 'SRCDOC', …)` sets srcdoc (round-5), so the comparison is
					// lowercased, while a computed key still fails closed.
					if (key === null || key.toLowerCase() === 'srcdoc')
						findings.push(
							`${file} calls .${callee.name}(…) with ${key === null ? 'a computed key that could be srcdoc' : `'${key}'`} — an alternate raw-HTML sink`
						);
					return;
				}
				if (callee.name === 'execCommand') {
					// R5-4: the legacy document.execCommand family — `insertHTML` is
					// the raw-HTML insertion the round-5 review planted, and command
					// IDs are case-insensitive per the spec, so the folded command is
					// compared lowercased; a computed command fails closed. Other
					// commands (copy, bold, …) do not insert HTML.
					const command = foldLocalKey(node.arguments[0]);
					if (command === null)
						findings.push(
							`${file} calls .execCommand with a computed command — the command could be 'insertHTML', a legacy raw-HTML insertion`
						);
					else if (command.toLowerCase() === 'inserthtml')
						findings.push(
							`${file} calls .execCommand('insertHTML', …) — a legacy raw-HTML insertion primitive that bypasses {@html} scanning`
						);
					return;
				}
				if (
					callee.name === 'defineProperty' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Object'
				) {
					const key = foldPropertyKey(node.arguments[1]);
					if (key === null || RAW_HTML_PROPERTY.has(key))
						findings.push(
							`${file} calls Object.defineProperty with ${key === null ? 'a computed raw-HTML-capable key' : `'${key}'`} — an alternate raw-HTML sink`
						);
					return;
				}
				if (
					callee.name === 'defineProperties' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Object'
				) {
					const descriptors = node.arguments[1];
					if (!ts.isObjectLiteralExpression(descriptors)) {
						findings.push(
							`${file} calls Object.defineProperties with computed descriptors — they could define raw-HTML properties`
						);
					} else {
						for (const descriptor of descriptors.properties) {
							const key =
								ts.isPropertyAssignment(descriptor) && ts.isComputedPropertyName(descriptor.name)
									? foldPropertyKey(descriptor.name.expression)
									: descriptor.name && ts.isIdentifier(descriptor.name)
										? descriptor.name.text
										: foldPropertyKey(descriptor.name);
							if (key === null || RAW_HTML_PROPERTY.has(key))
								findings.push(
									`${file} calls Object.defineProperties with ${key === null ? 'a computed raw-HTML-capable key' : `'${key}'`} — an alternate raw-HTML sink`
								);
						}
					}
					return;
				}
				if (callee.name === 'call' || callee.name === 'apply' || callee.name === 'bind') {
					const method = dangerousMethodName(callee.object);
					if (method)
						findings.push(
							`${file} invokes .${method} through .${callee.name}(…) — an alternate raw-HTML primitive`
						);
					return;
				}
				if (callee.name === 'write' || callee.name === 'writeln') {
					const names = objectNames(callee.object);
					if (isDocumentish(names)) {
						findings.push(
							`${file} calls document.${callee.name}(…) — an alternate raw-HTML sink that bypasses {@html} scanning`
						);
					} else if (!names.has('process')) {
						// Fail closed on an unproven receiver: a local alias or a
						// parameter could be a document under another name.
						findings.push(
							`${file} calls .${callee.name}(…) on a receiver this reading cannot prove is not a document — an alternate raw-HTML sink`
						);
					}
					return;
				}
				if (
					callee.name === 'set' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Reflect'
				) {
					const key = node.arguments[1];
					const folded = foldPropertyKey(key);
					if (folded !== null) {
						if (RAW_HTML_PROPERTY.has(folded)) {
							findings.push(
								`${file} calls Reflect.set with '${folded}' — an alternate raw-HTML sink that bypasses {@html} scanning`
							);
						}
					} else {
						findings.push(
							`${file} calls Reflect.set with a computed property key — it could set a raw-HTML property`
						);
					}
					return;
				}
				if (
					callee.name === 'assign' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Object'
				) {
					const receiver = node.arguments[0];
					if (receiver && isDocumentObject(receiver)) {
						findings.push(
							`${file} calls Object.assign on the document object — it can write raw-HTML properties`
						);
						return;
					}
					for (const arg of node.arguments.slice(1)) {
						if (ts.isObjectLiteralExpression(arg)) {
							for (const property of arg.properties) {
								if (ts.isSpreadAssignment(property)) continue;
								const key = ts.isShorthandPropertyAssignment(property)
									? property.name
									: ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name)
										? property.name.expression
										: property.name;
								const folded = key && ts.isIdentifier(key) ? key.text : foldPropertyKey(key);
								if (folded !== null && RAW_HTML_PROPERTY.has(folded)) {
									findings.push(
										`${file} calls Object.assign with '${folded}' in a source object — it can write a raw-HTML property`
									);
									break;
								}
							}
							continue;
						}
						// R5-4: an IDENTIFIER-laundered source — `const payload =
						// { srcdoc: html }; Object.assign(frame, payload)` carries the
						// dangerous key in a name this reading bound to an object
						// literal (through plain aliases and spreads), so the key is
						// seen through the name rather than only when written at the
						// call. A source this reading never saw is left to the
						// receiver-side and computed-key rules; it is not guessed at.
						if (ts.isIdentifier(arg) && objectLiteralKeys.has(arg.text)) {
							const laundered = [...objectLiteralKeys.get(arg.text)].find((key) =>
								RAW_HTML_PROPERTY.has(key)
							);
							if (laundered) {
								findings.push(
									`${file} calls Object.assign with '${laundered}' carried by ${arg.text} — a laundered source object can write a raw-HTML property`
								);
								break;
							}
						}
					}
					return;
				}
				return;
			}
		}
		if (ts.isJsxAttribute(node)) {
			// HTML/JSX attribute names are case-insensitive — `<iframe srcDoc=…>`
			// and `<iframe SRCDOC=…>` both set srcdoc (round-5).
			if (node.name.text.toLowerCase() === 'srcdoc') {
				findings.push(
					`${file} carries a srcdoc attribute — an alternate raw-HTML sink that bypasses {@html} scanning`
				);
			}
			return;
		}
		if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
			const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
			const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
			const properties = ts.isJsxAttributes(attributes) ? attributes.properties : [];
			const tagText = ts.isIdentifier(tag) ? tag.text : null;
			if (
				tagText === 'iframe' &&
				properties.some((attribute) => ts.isJsxSpreadAttribute(attribute))
			) {
				findings.push(
					`${file} spreads attributes onto an <iframe> — the spread can set srcdoc, an alternate raw-HTML sink`
				);
			}
			return;
		}
	});

	return findings;
}

/**
 * Alternate raw-HTML sinks in a Svelte component: `srcdoc` attributes and
 * iframe spreads in the markup plus the script blocks' sink sites.
 */
export function alternateSinksInSvelte(file, source) {
	const findings = svelteSrcdoc(file, source).map((detail) => `${file} ${detail}`);
	findings.push(...svelteIframeSpread(file, source).map((detail) => `${file} ${detail}`));
	const scriptContents = svelteScriptContents(file, source);
	for (const { text, context } of scriptContents) {
		const label = context === 'module' ? 'module script' : 'instance script';
		for (const finding of alternateSinksInScript(file, text, { jsx: false }))
			findings.push(`${finding} (${label})`);
	}
	return findings;
}

/**
 * Spread attributes on an `<iframe>` in Svelte markup — a spread can carry
 * `srcdoc`, so the element's attributes are not statically readable and the
 * position fails closed (round-2 evasion: spread attributes capable of setting
 * `srcdoc` on an iframe).
 */
export function svelteIframeSpread(file, source) {
	const ast = parseSvelte(file, source);
	const findings = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (
			(node.type === 'RegularElement' || node.type === 'SvelteElement') &&
			node.name === 'iframe' &&
			(node.attributes ?? []).some((attribute) => attribute.type === 'SpreadAttribute')
		) {
			findings.push(`<iframe {...spread}> spreads its attributes — the spread can set srcdoc`);
		}
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visit(node[key]);
		}
	};
	visit(ast.fragment);
	return findings;
}

/**
 * Whether a node names the `preview` prop or its `html` field — the value the
 * pinned display sink is allowed to read and nothing else. A COMPUTED access
 * is not a target this reading can clear: `preview[key]` could name `html`.
 */
export function isPreviewValueTarget(node) {
	if (!node) return false;
	if (ts.isIdentifier(node)) return node.text === 'preview';
	const access = propertyName(node);
	if (!access || access.computed) return false;
	if (access.name === 'html') {
		return ts.isIdentifier(access.object) && access.object.text === 'preview';
	}
	return false;
}

/** Whether a variable declaration initializes from `$props()` — the only
 *  runtime statement the display sink may carry. */
function isPropsDestructure(statement) {
	if (!ts.isVariableStatement(statement)) return false;
	const declarations = statement.declarationList.declarations;
	return (
		declarations.length === 1 &&
		declarations[0].initializer !== undefined &&
		ts.isCallExpression(declarations[0].initializer) &&
		ts.isIdentifier(declarations[0].initializer.expression) &&
		declarations[0].initializer.expression.text === '$props'
	);
}

function isTypeOnlyDeclaration(statement) {
	if (ts.isImportDeclaration(statement)) {
		const clause = statement.importClause;
		if (clause?.isTypeOnly) return true;
		if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			const elements = clause.namedBindings.elements;
			return elements.length > 0 && elements.every((element) => element.isTypeOnly);
		}
		return false;
	}
	return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

/**
 * The script-side binding of the ONE display sink (round-1 bypass B).
 *
 * The instance script may carry exactly the type-only declarations that define
 * the props type and ONE `let { preview } = $props()` destructure — nothing
 * else. That blanket rule is what makes "no transform before the sink"
 * provable: a `$effect` rewriting `preview.html`, a derived alias, an
 * `Object.assign(preview, …)`, a wrapper function called with the preview —
 * every one of those is a statement the script may not carry, and each is
 * named by this scan if it appears anyway. A module script may carry type-only
 * declarations only.
 */
export function previewDisplayScriptFindings(file, scripts) {
	const findings = [];
	for (const { text, context } of scripts) {
		const kind = context === 'module' ? 'module script' : 'instance script';
		const sourceFile = parseTypeScript(text, { file: `${file} (${kind})` });

		if (kind === 'instance script') {
			let propsDestructures = 0;
			for (const statement of sourceFile.statements) {
				if (isPropsDestructure(statement)) {
					propsDestructures += 1;
					continue;
				}
				if (isTypeOnlyDeclaration(statement)) continue;
				if (ts.isImportDeclaration(statement)) {
					findings.push(
						`${file} (${kind}) carries a value import (${statement
							.getText(sourceFile)
							.trim()}) — the display sink holds type-only imports, so nothing ` +
							'runtime-reachable can stand between lesser and the DOM'
					);
					continue;
				}
				if (ts.isVariableStatement(statement)) {
					findings.push(
						`${file} (${kind}) declares a variable other than the \`\$props()\` destructure — ` +
							'between lesser and the sink, nothing may hold or transform the preview value'
					);
					continue;
				}
				findings.push(
					`${file} (${kind}) carries a statement other than type-only declarations and the ` +
						'\`$props()\` destructure — a transform can hide in it'
				);
			}
			if (propsDestructures !== 1)
				findings.push(
					`${file} (${kind}) destructures \`\$props()\` ${propsDestructures} times — the sink needs ` +
						'exactly the one `preview` binding'
				);
		} else {
			for (const statement of sourceFile.statements) {
				if (isTypeOnlyDeclaration(statement)) continue;
				findings.push(
					`${file} (${kind}) carries a statement other than type-only declarations — ` +
						'a module script may not reach toward the display'
				);
			}
		}

		eachNode(sourceFile, (node) => {
			if (ts.isBinaryExpression(node)) {
				const operator = node.operatorToken.kind;
				if (operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment) {
					return;
				}
				if (isPreviewValueTarget(node.left)) {
					findings.push(
						`${file} (${kind}) assigns to the preview value — a mutation can transform lesser's ` +
							'bytes before the sink'
					);
				}
				return;
			}
			if (
				node.kind === ts.SyntaxKind.PrefixUnaryExpression ||
				node.kind === ts.SyntaxKind.PostfixUnaryExpression
			) {
				if (
					node.operator !== ts.SyntaxKind.PlusPlusToken &&
					node.operator !== ts.SyntaxKind.MinusMinusToken
				) {
					return;
				}
				if (isPreviewValueTarget(node.operand)) {
					findings.push(
						`${file} (${kind}) mutates the preview value — a mutation can transform lesser's ` +
							'bytes before the sink'
					);
				}
			}
		});
	}
	return findings;
}

/* -------------------------------------------------------------------------
 * R2-1 + R5-1 — the preview VALUE PATH, from `toDraftPreview` to the sink.
 *
 * Check 6 binds the sink file itself; the round-2 attack proved that was
 * not the whole path. A parent transform — a `$derived` that spreads
 * `preview` and rewrites `preview.html` before `<PreviewBody preview=…>`
 * — passed every check that only looked at PreviewBody.svelte, because the
 * value arriving at the sink was no longer lesser's bytes. This reading
 * closes the path: every `PreviewBody` invocation in owned source must pass
 * the preview value itself, verbatim, and that value must be bound only
 * from the `loadDraftPreview` result — never derived, spread, or written.
 *
 * THE ROUND-5 WIDENING. The round-5 adversarial review planted six shapes
 * that left the R2-1 reading green while lesser's bytes were still replaced
 * before the sink:
 *
 *   1. a declaration alias — `const p1 = preview; if (p1) p1.html = '…'` —
 *      because the write scan recognised only the identifier `preview`;
 *   2. a CROSS-FILE helper — `manglePreview(preview)` writing `p.html` in
 *      another module — because the scan read only the invoking file;
 *   3. a LOCAL helper — `function applyPreviewPatch(p) { p.html = '…' }`
 *      called with `preview` — because the scan never looked inside a
 *      function it was called with the value;
 *   4. wrapper receivers — `(preview).html = '…'`, `preview!.html = '…'`,
 *      `(preview as DraftPreview).html = '…'` — because the write scan
 *      matched the receiver node literally;
 *   5. an ASSIGNMENT alias — `let forwarded; forwarded = preview;
 *      Object.assign(forwarded, { html: '…' })` — because the alias closure
 *      followed only declarations, never assignments;
 *   6. a COMPILE-VALID DYNAMIC route — `previewSink = (await import(
 *      '$lib/review/PreviewBody.svelte')).default` plus
 *      `<svelte:component this={previewSink} {preview} />` with no static
 *      import at all — because every binding check was gated on a static
 *      import or invocation existing, and silence over the route read as a
 *      clean scan.
 *
 * The reading below binds the AUTHORIZED VALUE, not the identifier. The
 * value's identity is followed through declaration and assignment aliases,
 * TypeScript wrapper nodes (parentheses, `!`, `as`), the same-reference
 * runes `$state`/`$state.raw`, object-literal containers and their property
 * reads, array/map containers that receive the value, local functions that
 * return it, and every function a call hands it to — a local helper whose
 * parameter is written, or a helper that cannot be proven to leave its
 * parameter untouched, makes the call a finding. A call of the value into
 * anything this reading cannot statically prove direct — an imported
 * function, a method, an unbound name — FAILS CLOSED. Dynamic invocation
 * forms fail closed too: a `svelte:component` in a file that reaches
 * PreviewBody, or any dynamic `import('…PreviewBody.svelte')` in owned
 * source, is a route that cannot be statically proven direct. There is no
 * token blacklist anywhere in this reading: every rule is about the parsed
 * shape of an expression, and prose naming a sink is never a finding.
 * ---------------------------------------------------------------------- */

/** An assignment token — `=` through `**=`. */
function isAssignmentToken(kind) {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Strip a leading `await` from an expression. */
function unwrapAwait(node) {
	return node && ts.isAwaitExpression(node) ? node.expression : node;
}

/** A call to the session reader `loadDraftPreview(…)`. */
function isLoadDraftPreviewCall(node) {
	return (
		node !== null &&
		node !== undefined &&
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'loadDraftPreview'
	);
}

/** A `Promise.all([…])` call. */
function isPromiseAllCall(node) {
	return (
		node !== null &&
		node !== undefined &&
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'all' &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === 'Promise'
	);
}

/**
 * The local identifiers that provably hold a `loadDraftPreview` result: a
 * direct binding (`const X = await loadDraftPreview(…)`), or a member of a
 * `Promise.all([…])` destructure at the position whose element is the
 * `loadDraftPreview(…)` call (ReviewWorkspace's `previewResult`).
 */
function loadDraftPreviewResultIdentifiers(sourceFile) {
	const results = new Set();
	eachNode(sourceFile, (node) => {
		if (!ts.isVariableDeclaration(node) || !node.initializer) return;
		const init = unwrapAwait(node.initializer);
		if (isLoadDraftPreviewCall(init) && ts.isIdentifier(node.name)) {
			results.add(node.name.text);
			return;
		}
		if (
			isPromiseAllCall(init) &&
			ts.isArrayBindingPattern(node.name) &&
			ts.isArrayLiteralExpression(init.arguments[0])
		) {
			const elements = init.arguments[0].elements;
			const index = elements.findIndex((element) => isLoadDraftPreviewCall(element));
			if (index >= 0) {
				const binding = node.name.elements[index];
				if (binding && ts.isBindingElement(binding) && ts.isIdentifier(binding.name))
					results.add(binding.name.text);
			}
		}
	});
	return results;
}

/**
 * The one binding shape the preview value may have, on any path to the sink:
 *
 *   - `null` (the initial state),
 *   - `$state(null)` / `$state()` (the rune form of that initial state),
 *   - `<loadDraftPreview result>.value` — the verbatim projection,
 *   - a direct `loadDraftPreview(…)` call,
 *   - the identifier itself (a plain re-assignment).
 *
 * Anything else — an object literal, a spread reconstruction, a `$derived`
 * over `preview.html`, a call to `.replace`, a member read of `preview.html`
 * — is a transform, and a transform between lesser's bytes and the sink is
 * the round-2 attack shape.
 */
function isAuthorizedPreviewBinding(node, identifier, previewResults) {
	if (!node) return true; // `let preview;` — nothing assigned is nothing transformed
	if (node.kind === ts.SyntaxKind.NullKeyword) return true;
	if (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === '$state' &&
		node.arguments.length === 0
	)
		return true;
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === '$state' &&
		node.expression.name.text === 'raw' &&
		node.arguments.length === 1 &&
		node.arguments[0].kind === ts.SyntaxKind.NullKeyword
	)
		return true;
	if (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === '$state' &&
		node.arguments.length === 1 &&
		node.arguments[0].kind === ts.SyntaxKind.NullKeyword
	)
		return true;
	if (ts.isIdentifier(node) && node.text === identifier) return true;
	if (isLoadDraftPreviewCall(node)) return true;
	const access = propertyName(node);
	if (
		access &&
		!access.computed &&
		access.name === 'value' &&
		ts.isIdentifier(access.object) &&
		previewResults.has(access.object.text)
	)
		return true;
	return false;
}

/**
 * R2-1's check: every `PreviewBody` invocation, bound at the caller.
 *
 * The compiler's own reading finds every `Component` named `PreviewBody`.
 * For each, the `preview` attribute must be the identifier itself — a
 * member access, a call, a conditional, or an object can only be a computed
 * or reconstructed value. That identifier's bindings must all be
 * `isAuthorizedPreviewBinding`, and the file may neither write to its
 * `.html` field nor spread it into a new object — both would transform
 * lesser's bytes or reconstruct the `DraftPreview` between `toDraftPreview`
 * and the sink.
 */
/**
 * R5-1: the file-wide AUTHORIZED-VALUE binding that replaces the narrow
 * per-identifier write scan.
 *
 * `valueNames` is the set of identifiers this reading can prove carry the
 * preview reference. It grows by same-reference means only: declarations and
 * assignments whose right side IS a value name (in any TypeScript wrapper
 * spelling), the same-reference runes `$state`/`$state.raw` wrapping one, a
 * property read of a local object literal that was built holding the value,
 * an element read of an array that received the value, a `Map#get` on a map
 * that received it, and the result of a local function that returns the
 * value. Every `.html` write on a value name — parenthesized, non-null, or
 * cast — every property write on one, every computed write through one,
 * every mutation API (`Object.assign`, `Reflect.set`, `defineProperty`,
 * `defineProperties`) receiving one, every spread of one, and every call
 * handed one is a finding; a call handed one is a finding unless the callee
 * is a LOCAL function this reading proves never writes to its parameters.
 */

/**
 * Unwrap the TypeScript wrapper nodes an expression can be dressed in —
 * parentheses, the non-null assertion, `as`/`<T>` casts, and `satisfies`.
 * `(preview).html = …`, `preview!.html = …` and `(preview as
 * DraftPreview).html = …` all write through a node the literal spelling
 * does not have, so every receiver comparison unwraps before it compares.
 */
function unwrapValueNode(node) {
	let current = node;
	while (current) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isSatisfiesExpression(current)
		) {
			current = current.expression;
			continue;
		}
		return current;
	}
	return current;
}

function previewValuePathFindings(file, sourceFile) {
	const findings = [];

	// --- the growing facts ----------------------------------------------------
	const valueNames = new Set(['preview']);
	const containerPaths = new Map(); // identifier -> Set<property | '*'>
	const arrayContainers = new Set();
	const mapContainers = new Set();
	const previewReturning = new Set(); // callee names that return the value
	const importedNames = new Set();
	const functions = new Map(); // callee name -> [{ node, paramNames }]

	const addValueName = (name) => {
		if (!valueNames.has(name)) {
			valueNames.add(name);
			return true;
		}
		return false;
	};

	eachNode(sourceFile, (node) => {
		if (ts.isFunctionDeclaration(node) && node.name) {
			functions.set(node.name.text, [
				...(functions.get(node.name.text) ?? []),
				{ node, paramNames: node.parameters.map((p) => p.name) },
			]);
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const init = unwrapValueNode(node.initializer);
			if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
				functions.set(node.name.text, [
					...(functions.get(node.name.text) ?? []),
					{ node: init, paramNames: init.parameters.map((p) => p.name) },
				]);
			}
		}
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
			const clause = node.importClause;
			if (clause?.name) importedNames.add(clause.name.text);
			if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements)
					if (!element.isTypeOnly) importedNames.add(element.name.text);
			}
			if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
				importedNames.add(clause.namedBindings.name.text);
		}
	});

	/** `$state(<value>)` / `$state.raw(<value>)` — same-reference rune wrappers. */
	const runeAliasArgument = (call) => {
		if (call.arguments.length !== 1) return null;
		if (ts.isIdentifier(call.expression) && call.expression.text === '$state')
			return call.arguments[0];
		if (
			ts.isPropertyAccessExpression(call.expression) &&
			ts.isIdentifier(call.expression.expression) &&
			call.expression.expression.text === '$state' &&
			call.expression.name.text === 'raw'
		)
			return call.arguments[0];
		return null;
	};

	/** Whether an expression provably holds the preview reference. */
	const holdsValue = (expr) => {
		if (!expr) return false;
		const inner = unwrapValueNode(expr);
		if (ts.isIdentifier(inner)) return valueNames.has(inner.text);
		if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
			const props = containerPaths.get(inner.expression.text);
			return Boolean(props && (props.has(inner.name.text) || props.has('*')));
		}
		if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
			return arrayContainers.has(inner.expression.text) || mapContainers.has(inner.expression.text);
		}
		if (ts.isCallExpression(inner)) {
			const rune = runeAliasArgument(inner);
			if (rune) return holdsValue(rune);
			if (ts.isIdentifier(inner.expression) && previewReturning.has(inner.expression.text))
				return true;
			if (
				ts.isPropertyAccessExpression(inner.expression) &&
				ts.isIdentifier(inner.expression.expression) &&
				mapContainers.has(inner.expression.expression.text) &&
				inner.expression.name.text === 'get'
			)
				return true;
		}
		return false;
	};

	// --- fixed point: value names, containers, and returning functions -------
	let changed = true;
	while (changed) {
		changed = false;

		// Bindings and container records.
		eachNode(sourceFile, (node) => {
			let bound = null;
			let rhs = null;
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
				bound = node.name.text;
				rhs = node.initializer;
			} else if (
				ts.isBinaryExpression(node) &&
				(node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
					node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) &&
				ts.isIdentifier(node.left)
			) {
				bound = node.left.text;
				rhs = node.right;
			}
			if (bound === null || valueNames.has(bound)) return;

			if (rhs && holdsValue(rhs)) {
				if (addValueName(bound)) changed = true;
				return;
			}
			const inner = unwrapValueNode(rhs);
			if (!inner) return;
			if (ts.isObjectLiteralExpression(inner)) {
				const props = new Set();
				let holds = false;
				for (const property of inner.properties) {
					if (ts.isSpreadAssignment(property)) continue;
					let key = null;
					let valueExpr = null;
					if (ts.isPropertyAssignment(property)) {
						key = ts.isComputedPropertyName(property.name)
							? foldPropertyKey(property.name.expression)
							: ts.isIdentifier(property.name)
								? property.name.text
								: ts.isStringLiteral(property.name)
									? property.name.text
									: null;
						valueExpr = property.initializer;
					} else if (ts.isShorthandPropertyAssignment(property)) {
						key = property.name.text;
						valueExpr = property.name;
					}
					if (valueExpr && holdsValue(valueExpr)) {
						holds = true;
						props.add(key ?? '*');
					}
				}
				if (holds && !containerPaths.has(bound)) {
					containerPaths.set(bound, props);
					changed = true;
				}
			} else if (ts.isArrayLiteralExpression(inner)) {
				if (
					inner.elements.some(
						(element) => !ts.isSpreadElement(element) && holdsValue(element)
					) &&
					!arrayContainers.has(bound)
				) {
					arrayContainers.add(bound);
					changed = true;
				}
			}
		});

		// Containers receiving the value through a mutation method.
		eachNode(sourceFile, (node) => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				['set', 'push', 'add', 'unshift', 'splice'].includes(node.expression.name.text) &&
				node.arguments.some((argument) => holdsValue(argument)) &&
				!mapContainers.has(node.expression.expression.text)
			) {
				mapContainers.add(node.expression.expression.text);
				changed = true;
			}
		});

		// Local functions that return the value — walked to the function's own
		// boundary so a nested arrow's return is not credited to its parent. A
		// concise arrow's body IS the returned expression.
		for (const [name, infos] of functions) {
			if (previewReturning.has(name)) continue;
			for (const { node } of infos) {
				let returns = false;
				const body = node.body;
				if (ts.isArrowFunction(node) && body && !ts.isBlock(body) && holdsValue(body)) {
					returns = true;
				} else {
					eachNodeOwn(body ?? node, (n) => {
						if (returns) return;
						if (ts.isReturnStatement(n) && n.expression && holdsValue(n.expression))
							returns = true;
					});
				}
				if (returns) {
					previewReturning.add(name);
					changed = true;
					break;
				}
			}
		}
	}

	// --- mutating-function fixed point ---------------------------------------
	// A function mutates a parameter-derived reference when it writes a
	// property of one (in any wrapper spelling), writes through a computed key
	// on one, hands one to `Object.assign`/`Reflect.set`/`defineProperty`/
	// `defineProperties`, spreads one, stores one into anything else, or hands
	// one to a callee that is itself mutating — or to any callee this reading
	// cannot prove leaves its argument untouched.
	const paramDerivedNames = (fnNode, paramNames) => {
		const derived = new Set();
		for (const param of paramNames) {
			const names = bindingNames(param);
			for (const name of names) derived.add(name);
		}
		let grew = true;
		while (grew) {
			grew = false;
			eachNode(fnNode.body ?? fnNode, (node) => {
				if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
					const inner = unwrapValueNode(node.initializer);
					if (ts.isIdentifier(inner) && derived.has(inner.text) && !derived.has(node.name.text)) {
						derived.add(node.name.text);
						grew = true;
					}
				}
				if (
					ts.isBinaryExpression(node) &&
					node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					ts.isIdentifier(node.left) &&
					node.right
				) {
					const inner = unwrapValueNode(node.right);
					if (ts.isIdentifier(inner) && derived.has(inner.text) && !derived.has(node.left.text)) {
						derived.add(node.left.text);
						grew = true;
					}
				}
			});
		}
		return derived;
	};
	const directlyMutates = (fnNode, derived) => {
		let found = false;
		eachNode(fnNode.body ?? fnNode, (node) => {
			if (found) return;
			if (ts.isBinaryExpression(node) && isAssignmentToken(node.operatorToken.kind)) {
				const access = propertyName(node.left);
				if (access) {
					const receiver = unwrapValueNode(access.object);
					if (ts.isIdentifier(receiver) && derived.has(receiver.text)) {
						found = true;
						return;
					}
				}
				// `saved = p` — the value escapes the function's own frame into a
				// name or property this reading cannot prove is write-protected.
				const right = unwrapValueNode(node.right);
				if (ts.isIdentifier(right) && derived.has(right.text)) {
					found = true;
					return;
				}
				return;
			}
			if (
				node.kind === ts.SyntaxKind.PrefixUnaryExpression ||
				node.kind === ts.SyntaxKind.PostfixUnaryExpression
			) {
				const access = propertyName(node.operand);
				const receiver = access && unwrapValueNode(access.object);
				if (ts.isIdentifier(receiver) && derived.has(receiver.text)) found = true;
				return;
			}
			if (ts.isSpreadAssignment(node)) {
				const expr = unwrapValueNode(node.expression);
				if (ts.isIdentifier(expr) && derived.has(expr.text)) found = true;
				return;
			}
			if (ts.isCallExpression(node)) {
				const callee = propertyName(node.expression);
				if (callee && ts.isIdentifier(callee.object)) {
					const receiver = node.arguments[0];
					const object = receiver && unwrapValueNode(receiver);
					if (
						ts.isIdentifier(object) &&
						derived.has(object.text) &&
						((callee.object.text === 'Object' &&
							['assign', 'defineProperty', 'defineProperties'].includes(callee.name)) ||
							(callee.object.text === 'Reflect' && callee.name === 'set'))
					) {
						found = true;
						return;
					}
				}
			}
		});
		return found;
	};
	const handsToUnprovenOrMutating = (fnNode, derived) => {
		let found = false;
		eachNode(fnNode.body ?? fnNode, (node) => {
			if (found) return;
			if (!ts.isCallExpression(node)) return;
			if (!node.arguments.some((argument) => holdsParamReference(argument, derived))) return;
			const calleeExpr = unwrapValueNode(node.expression);
			if (ts.isIdentifier(calleeExpr)) {
				const infos = functions.get(calleeExpr.text);
				if (infos && infos.length) {
					// Same-file: mutating only when a binding is itself mutating.
					if (mutatingFunctions.has(calleeExpr.text)) found = true;
					return;
				}
				found = true; // imported or unbound — cannot be proven clean
				return;
			}
			found = true; // a method or other computed callee — cannot be proven clean
		});
		return found;
	};
	const holdsParamReference = (argument, derived) => {
		const inner = unwrapValueNode(argument);
		return ts.isIdentifier(inner) && derived.has(inner.text);
	};
	const mutatingFunctions = new Set();
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, infos] of functions) {
			if (mutatingFunctions.has(name)) continue;
			for (const { node, paramNames } of infos) {
				const derived = paramDerivedNames(node, paramNames);
				if (
					derived.size > 0 &&
					(directlyMutates(node, derived) || handsToUnprovenOrMutating(node, derived))
				) {
					mutatingFunctions.add(name);
					grew = true;
					break;
				}
			}
		}
	}

	// --- the write / mutation / call scan ------------------------------------
	const containerRooted = (node) => {
		const inner = unwrapValueNode(node);
		if (ts.isIdentifier(inner)) return arrayContainers.has(inner.text) || mapContainers.has(inner.text);
		if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression))
			return arrayContainers.has(inner.expression.text) || mapContainers.has(inner.expression.text);
		if (ts.isCallExpression(inner)) {
			const callee = propertyName(inner.expression);
			return Boolean(
				callee &&
					ts.isIdentifier(callee.object) &&
					mapContainers.has(callee.object.text) &&
					(callee.name === 'get' || callee.name === 'values')
			);
		}
		return false;
	};
	const callResultRooted = (node) => {
		const inner = unwrapValueNode(node);
		return (
			ts.isCallExpression(inner) &&
			ts.isIdentifier(inner.expression) &&
			previewReturning.has(inner.expression.text)
		);
	};

	eachNode(sourceFile, (node) => {
		if (ts.isBinaryExpression(node) && isAssignmentToken(node.operatorToken.kind)) {
			const access = propertyName(node.left);
			if (access) {
				const receiver = unwrapValueNode(access.object);
				if (ts.isIdentifier(receiver) && valueNames.has(receiver.text)) {
					if (access.computed)
						findings.push(
							`${file} writes through a computed key on ${receiver.text} — the key could be 'html' and lesser's bytes would be transformed before the sink`
						);
					else
						findings.push(
							`${file} writes to ${receiver.text}.${access.name} — a mutation can transform lesser's bytes before the sink`
						);
					return;
				}
				if (!access.computed && access.name === 'html') {
					if (containerRooted(receiver))
						findings.push(
							`${file} writes to .html on a value that entered a local container — lesser's preview bytes can be transformed before the sink`
						);
					else if (callResultRooted(receiver))
						findings.push(
							`${file} writes to .html on a value returned by a preview-returning helper — lesser's preview bytes can be transformed before the sink`
						);
					else if (holdsValue(receiver))
						findings.push(
							`${file} writes to .html on ${receiver
								.getText(sourceFile)
								.slice(0, 40)}… — a value bound to the preview reference can be transformed before the sink`
						);
				}
			}
			return;
		}
		if (
			node.kind === ts.SyntaxKind.PrefixUnaryExpression ||
			node.kind === ts.SyntaxKind.PostfixUnaryExpression
		) {
			const access = propertyName(node.operand);
			if (access) {
				const receiver = unwrapValueNode(access.object);
				if (ts.isIdentifier(receiver) && valueNames.has(receiver.text))
					findings.push(
						`${file} mutates ${receiver.text}.${access.computed ? '[key]' : access.name} — a mutation can transform lesser's bytes before the sink`
					);
			}
			return;
		}
		if (ts.isSpreadAssignment(node)) {
			const expr = unwrapValueNode(node.expression);
			if (ts.isIdentifier(expr) && valueNames.has(expr.text))
				findings.push(
					`${file} spreads ${expr.text} into a new object — reconstructing the DraftPreview between loadDraftPreview and the sink`
				);
			return;
		}
		if (ts.isCallExpression(node)) {
			const callee = propertyName(node.expression);
			if (callee && ts.isIdentifier(callee.object)) {
				const receiver = node.arguments[0];
				const object = receiver && unwrapValueNode(receiver);
				if (
					ts.isIdentifier(object) &&
					valueNames.has(object.text) &&
					((callee.object.text === 'Object' &&
						['assign', 'defineProperty', 'defineProperties'].includes(callee.name)) ||
						(callee.object.text === 'Reflect' && callee.name === 'set'))
				) {
					findings.push(
						`${file} mutates ${object.text} through ${callee.object.text}.${callee.name}(…) — lesser's preview value must remain verbatim`
					);
					return;
				}
			}
			if (!node.arguments.some((argument) => holdsValue(argument))) return;
			// `$state(<value>)` / `$state.raw(<value>)` are same-reference rune
			// wrappers, not function hops — the value stays the preview object
			// and its mutations are caught by the write scan above.
			if (runeAliasArgument(node)) return;
			const calleeExpr = unwrapValueNode(node.expression);
			if (ts.isIdentifier(calleeExpr)) {
				const infos = functions.get(calleeExpr.text);
				if (infos && infos.length) {
					if (mutatingFunctions.has(calleeExpr.text))
						findings.push(
							`${file} passes the preview value to ${calleeExpr.text}(…), whose parameter is written — a helper hop transforms lesser's bytes before the sink`
						);
				} else {
					findings.push(
						`${file} passes the preview value to ${calleeExpr.text}(…) — a function hop between loadDraftPreview and the sink cannot be statically proven direct`
					);
				}
				return;
			}
			findings.push(
				`${file} passes the preview value to ${node.expression
					.getText(sourceFile)
					.slice(0, 60)}… — a route between loadDraftPreview and the sink cannot be statically proven direct`
			);
		}
	});

	return findings;
}

/**
 * Every name a binding pattern binds, at any depth — a destructured parameter
 * is a reference INTO its object, so a write through one of its members is a
 * write to the object the parameter carries.
 */
function bindingNames(name) {
	const names = [];
	const visit = (node) => {
		if (!node) return;
		if (ts.isIdentifier(node)) {
			names.push(node.text);
			return;
		}
		if (ts.isBindingElement(node)) {
			visit(node.name);
			return;
		}
		if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
			for (const element of node.elements) visit(element);
		}
	};
	visit(name);
	return names;
}

/**
 * Depth-first over a function's OWN body, stopping at nested function
 * boundaries — a nested arrow's `return preview` is the nested function's
 * return, never its parent's. `top` admits the node the walk starts on even
 * when it is itself a function.
 */
function eachNodeOwn(node, visit, top = true) {
	if (!node || typeof node !== 'object') return;
	if (
		!top &&
		(ts.isFunctionDeclaration(node) ||
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isMethodDeclaration(node))
	)
		return;
	visit(node);
	ts.forEachChild(node, (child) => eachNodeOwn(child, visit, false));
}

/**
 * R2-1 + R5-1 — every `PreviewBody` invocation, bound at the caller.
 *
 * The compiler's own reading finds every `Component` named `PreviewBody`.
 * For each, the `preview` attribute must be the identifier itself — a
 * member access, a call, a conditional, or an object can only be a computed
 * or reconstructed value. That identifier's bindings must all be
 * `isAuthorizedPreviewBinding`, and the file may neither write to its
 * `.html` field nor spread it into a new object — both would transform
 * lesser's bytes or reconstruct the `DraftPreview` between `toDraftPreview`
 * and the sink.
 *
 * R5-1 adds the fail-closed route and the authorized-value binding:
 *
 *   - a dynamic `import('…PreviewBody.svelte')` anywhere in owned source is
 *     a finding — the module can be reached without the canonical static
 *     import the binding is keyed on;
 *   - a `svelte:component` in a file that reaches PreviewBody is a finding —
 *     a dynamic component route cannot be statically proven direct;
 *   - the canonical file must carry exactly the one static import and one
 *     static invocation — a file whose route is missing or dynamic fails
 *     instead of scanning clean;
 *   - the value's identity is then bound file-wide (`previewValuePathFindings`)
 *     across aliases, wrappers, containers, returning helpers, and function
 *     hops, so every transform of lesser's bytes before the sink is a
 *     finding even when the identifier `preview` never appears in it.
 */
export function previewInvocationFindings(file, source) {
	const ast = parseSvelte(file, source);
	const invocations = [];
	const svelteComponents = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'Component' && node.name === 'PreviewBody') invocations.push(node);
		if (node.type === 'SvelteComponent') svelteComponents.push(node);
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visit(node[key]);
		}
	};
	visit(ast.fragment);
	const findings = [];
	const scriptText = svelteScriptContents(file, source)
		.map(({ text }) => text)
		.join('\n');
	let sourceFile;
	try {
		sourceFile = parseTypeScript(scriptText, { file: `${file} (scripts)` });
	} catch (error) {
		return [
			`${file} could not read its script text, so the preview value path cannot be verified: ${error.message}`,
		];
	}
	const previewResults = loadDraftPreviewResultIdentifiers(sourceFile);

	const previewImports = [];
	eachNode(sourceFile, (node) => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			/(?:^|\/)PreviewBody\.svelte$/.test(node.moduleSpecifier.text)
		)
			previewImports.push(node);
	});
	// Markup `import(…)` — the modern AST exposes `ImportExpression` nodes the
	// script text never contains. (The modern AST ALSO surfaces script-side
	// imports as `ImportExpression` nodes in the tree, so the two collections
	// are merged into one set — a script import must not read as two.)
	const dynamicSpecifiers = new Set();
	eachNode(sourceFile, (node) => {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const specifier = foldPropertyKey(node.arguments[0]);
			if (specifier !== null && /(?:^|\/)PreviewBody\.svelte$/.test(specifier))
				dynamicSpecifiers.add(specifier);
		}
	});
	const visitMarkup = (node) => {
		if (!node || typeof node !== 'object') return;
		if (
			node.type === 'ImportExpression' &&
			node.source &&
			typeof node.source.value === 'string' &&
			/(?:^|\/)PreviewBody\.svelte$/.test(node.source.value)
		)
			dynamicSpecifiers.add(node.source.value);
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visitMarkup(node[key]);
		}
	};
	visitMarkup(ast);

	const canonicalFile = 'src/lib/routes/ReviewWorkspace.svelte';
	const previewReach =
		previewImports.length > 0 ||
		invocations.length > 0 ||
		dynamicSpecifiers.size > 0;

	// --- dynamic invocation forms fail closed ---------------------------------
	for (const specifier of dynamicSpecifiers)
		findings.push(
			`${file} dynamically imports the PreviewBody module (${specifier}) — a dynamic component route cannot be statically proven direct`
		);
	for (const component of svelteComponents) {
		const thisExpression = component.expression;
		if (thisExpression?.type === 'Identifier' && thisExpression.name === 'PreviewBody') {
			findings.push(
				`${file} dynamically invokes PreviewBody — a dynamic component route cannot be statically proven direct`
			);
			continue;
		}
		if (previewReach)
			findings.push(
				`${file} invokes a component through <svelte:component this={…}> — a dynamic route cannot be statically proven direct`
			);
	}

	if (!previewReach) {
		if (file === canonicalFile)
			findings.push(
				`${file} carries no PreviewBody import, invocation, or dynamic route — the authorized display route is missing`
			);
		return findings;
	}

	if (file !== canonicalFile)
		findings.push(
			`${file} reaches PreviewBody outside ${canonicalFile} — wrappers and cross-file forwarding are not an authorized direct path`
		);
	if (previewImports.length !== 1)
		findings.push(
			`${file} imports PreviewBody ${previewImports.length} times — the authorized route has exactly one canonical import`
		);
	for (const declaration of previewImports) {
		const local = declaration.importClause?.name?.text;
		if (
			declaration.moduleSpecifier.text !== '$lib/review/PreviewBody.svelte' ||
			local !== 'PreviewBody'
		)
			findings.push(
				`${file} aliases or reroutes the PreviewBody import — the authorized route uses the canonical default binding`
			);
	}
	if (invocations.length !== 1)
		findings.push(
			`${file} has ${invocations.length} static PreviewBody invocations — the authorized route has exactly one`
		);
	if (invocations.length === 0) return findings;

	for (const component of invocations) {
		const attribute = (component.attributes ?? []).find(
			(entry) => entry.type === 'Attribute' && entry.name === 'preview'
		);
		if (!attribute) {
			findings.push(
				`${file} instantiates PreviewBody without a preview attribute — the sink must receive the authorized preview result`
			);
			continue;
		}
		const values = Array.isArray(attribute.value)
			? attribute.value
			: [attribute.value].filter(Boolean);
		const tags = values.filter((value) => value?.type === 'ExpressionTag');
		const expression = tags[0]?.expression;
		const isSvelteIdentifier =
			expression &&
			typeof expression === 'object' &&
			expression.type === 'Identifier' &&
			typeof expression.name === 'string';
		const attributeText = isSvelteIdentifier
			? expression.name
			: JSON.stringify(attribute.value)?.slice(0, 60);
		if (tags.length !== 1 || !isSvelteIdentifier) {
			findings.push(
				`${file} binds the PreviewBody sink to ${attributeText ?? 'a non-identifier'} — every invocation must pass the preview value itself, verbatim`
			);
			continue;
		}
		const identifier = expression.name;
		if (identifier !== 'preview')
			findings.push(
				`${file} forwards ${identifier} to PreviewBody — the canonical invocation must pass the load result binding named preview directly`
			);

		// The identifier's OWN bindings stay bound (R2-1): every declaration and
		// assignment of the invocation's attribute identifier must be one of the
		// authorized shapes — never derived, spread, or reconstructed.
		eachNode(sourceFile, (node) => {
			if (ts.isVariableDeclaration(node)) {
				if (!ts.isIdentifier(node.name) || node.name.text !== identifier) return;
				if (!isAuthorizedPreviewBinding(node.initializer, identifier, previewResults)) {
					findings.push(
						`${file} binds ${identifier} from ${node.initializer
							?.getText(sourceFile)
							.slice(
								0,
								80
							)}… — the preview value must be the loadDraftPreview result verbatim, never derived or reconstructed`
					);
				}
				return;
			}
			if (ts.isBinaryExpression(node) && isAssignmentToken(node.operatorToken.kind)) {
				if (ts.isIdentifier(node.left) && node.left.text === identifier) {
					if (!isAuthorizedPreviewBinding(node.right, identifier, previewResults)) {
						findings.push(
							`${file} assigns ${identifier} from ${node.right
								?.getText(sourceFile)
								.slice(
									0,
									80
								)}… — the preview value must be the loadDraftPreview result verbatim, never derived or reconstructed`
						);
					}
					return;
				}
			}
		});
	}

	if (file === canonicalFile) findings.push(...previewValuePathFindings(file, sourceFile));

	return findings;
}
