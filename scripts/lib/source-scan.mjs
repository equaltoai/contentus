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
 * ROUND 6 ADDED THE OTHER DIMENSION. The round-6 adversarial review planted
 * ten shapes that left even the parser-based reading green, and they share one
 * root cause: the reading was scoped to a FILE and a SYNTAX SHAPE, while the
 * value and the callee moved across both. A wrapper component that receives
 * the PreviewBody COMPONENT and the preview VALUE through props and invokes
 * them via `<svelte:component>` never imports PreviewBody, so no per-file
 * reach key fired; the preview identity escaped through destructures, getters,
 * constructors, loop bindings and callbacks; and dangerous built-ins escaped
 * through identifier aliases, destructures, `.call/.apply/.bind`, call-result
 * payloads and spread payload arrays. The closures below follow the VALUE and
 * the CALLEE through those forms — `previewForwardingFindings` across the
 * owned module graph, `previewValuePathFindings` across the binding forms the
 * round-6 plants used, and `alternateSinksInScript` across builtin aliases and
 * laundered payloads — failing closed wherever the flow cannot be proven to be
 * the one canonical direct route.
 *
 * FAIL-CLOSED ON UNPARSEABLE SOURCE. Every function throws when the compiler or
 * parser cannot read its input; the audit converts a throw into a finding. A
 * file the toolchain cannot parse is a file whose sinks this gate cannot see,
 * and silence over it is the exact failure the round-1 report demonstrated.
 *
 * THE ONE COPY. The audit imports this module, and the probes drive the audit;
 * a second definition of any scan here would be free to drift from the gate.
 *
 * ROUND 7 STATED PLAINLY, because the round-6 prose outran the round-6 code
 * and the round-7 review proved it. What round 6 shipped did NOT fail closed
 * on a static invocation whose callee was a prop, an unbound name, a dotted
 * member, or an owned barrel — those callees were skipped; it did not read a
 * markup spread's keys; it did not follow the preview identity into
 * containers populated after declaration, through collection transforms, or
 * through computed element access; and it did not model descriptor setters,
 * bound method copies, `Reflect.apply`, or the `setHTML` family. Round 7
 * added exactly those closures, each fail-closed at the point its flow cannot
 * be proven the one canonical direct route, and each probed by
 * `tests/renderer-authority-audit.test.mjs`. What the reading still does not
 * claim is also stated: it is a static analysis over the owned module graph —
 * it proves the shapes it models and fails closed on the shapes it cannot
 * resolve, and it says nothing about a shape it has not yet met.
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
 * Array-iteration methods whose callback receives the ELEMENT as a parameter
 * (the second parameter for `reduce`, whose first is the accumulator). The
 * round-6 reading uses them to follow the preview reference into callback
 * parameters — `[preview].forEach((p) => { p.html = … })` hands the value to
 * the callback exactly as a function call would.
 */
const ARRAY_ITERATION_METHODS = new Set([
	'forEach',
	'map',
	'filter',
	'some',
	'every',
	'find',
	'findIndex',
	'flatMap',
	'reduce',
]);

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
	// R7-4: the Sanitizer-API family is treated as raw/rewriting sinks wherever
	// a browser supports them. `setHTML` rewrites an element's content through a
	// sanitizer contentus does not control — a second opinion over lesser's
	// bytes — and `setHTMLUnsafe`/`setHTMLUnchecked` skip sanitizing entirely.
	// The exact names are the rule: an unrelated method that merely contains one
	// of them as a substring is not matched.
	const DANGEROUS_METHOD_NAMES = [
		'write',
		'writeln',
		'insertAdjacentHTML',
		'createContextualFragment',
		'parseFromString',
		// R6-3 residual: `setHTMLUnchecked` is Chromium's un-sanitizing HTML
		// setter — always dangerous when called, so an alias or destructure
		// of it is treated like the other always-dangerous method names.
		'setHTML',
		'setHTMLUnsafe',
		'setHTMLUnchecked',
	];
	const dangerousMethodName = (node) => {
		const access = propertyName(node);
		if (!access || access.computed) return null;
		return DANGEROUS_METHOD_NAMES.includes(access.name) ? access.name : null;
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
					if (!DANGEROUS_METHOD_NAMES.includes(method)) continue;
					if (ts.isIdentifier(element.name)) dangerousMethodAliases.set(element.name.text, method);
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

	/** Strip parentheses — `(expr)` is the same expression for every reading. */
	const unwrapParen = (node) => {
		let current = node;
		while (current && ts.isParenthesizedExpression(current)) current = current.expression;
		return current;
	};

	/**
	 * The key an Object.assign SOURCE-OBJECT property writes, folded through
	 * constant strings (R7-4): `const key = 'innerHTML'; Object.assign(host, {
	 * [key]: html })` writes the key the constant names, and a computed key no
	 * static read can fold returns null — the caller decides what an unfolded
	 * computed key means (the assign walk fails closed on one into a receiver
	 * it cannot prove a container).
	 */
	const sourcePropertyKey = (property) => {
		if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
		if (!ts.isPropertyAssignment(property)) return null;
		if (ts.isComputedPropertyName(property.name)) return foldLocalKey(property.name.expression);
		if (ts.isIdentifier(property.name)) return property.name.text;
		if (ts.isStringLiteral(property.name)) return property.name.text;
		return null;
	};
	const sourceKeyComputed = (property) =>
		ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name);

	// R7-4: DESCRIPTOR SETTER EXTRACTION. `Object.getOwnPropertyDescriptor(
	// Element.prototype, 'innerHTML')?.set?.call(host, html)` launders the write
	// through the property descriptor: the sink is no longer a member write on
	// the element, it is a call of the extracted setter. The reading records
	// every local bound to a descriptor lookup and recognizes the inline
	// spelling too; the verdict belongs to the descriptor's KEY — a folded
	// dangerous write property, or a key no static read can fold, fails closed,
	// and a folded non-dangerous key (`'title'`) stays clean. `set` is also the
	// Map/WeakMap mutator, so the rule never fires on the bare name — only on a
	// `.set` read OFF a descriptor source.
	const DESCRIPTOR_LOOKUPS = new Set(['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors']);
	const descriptorNames = new Map(); // name -> { key: string | null, all: boolean }
	const isDescriptorLookupCall = (node) => {
		const inner = unwrapParen(node);
		if (!inner || !ts.isCallExpression(inner)) return null;
		const callee = propertyName(inner.expression);
		if (!callee || callee.computed || !DESCRIPTOR_LOOKUPS.has(callee.name)) return null;
		const objectNamesOfCallee = ts.isIdentifier(callee.object) ? callee.object.text : null;
		if (objectNamesOfCallee !== 'Object' && objectNamesOfCallee !== 'Reflect') return null;
		const all = callee.name === 'getOwnPropertyDescriptors';
		// The described property key: the second argument for the single lookup.
		const key = all ? null : foldLocalKey(inner.arguments[1]);
		return { key, all };
	};
	eachNode(sourceFile, (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const lookup = isDescriptorLookupCall(node.initializer);
			if (lookup) descriptorNames.set(node.name.text, lookup);
		}
	});
	/**
	 * An EXTRACTED descriptor setter bound to a local — `const s = desc?.set`
	 * — is the descriptor's setter under another name, and a later `s.call(…)`
	 * or `s(…)` must fire exactly as the inline spelling does. The extraction
	 * joins the dangerous-method aliases, labelled by the descriptor's key, so
	 * the existing alias and `.call/.apply/.bind` machinery carries it. A
	 * descriptor whose key folds to a non-dangerous property is not a sink and
	 * binds nothing.
	 */
	const descriptorSetterExtractions = () => {
		eachNode(sourceFile, (node) => {
			let bound = null;
			let rhs = null;
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
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
			if (bound === null || !rhs || dangerousMethodAliases.has(bound)) return;
			const source = descriptorSetSource(rhs);
			if (!source) return;
			if (source.all || source.key === null) {
				dangerousMethodAliases.set(bound, 'an unresolved descriptor setter');
				return;
			}
			if (RAW_HTML_WRITE_PROPERTY.has(source.key) || DANGEROUS_METHOD_NAMES.includes(source.key))
				dangerousMethodAliases.set(bound, `'${source.key}' descriptor setter`);
		});
	};

	/**
	 * The descriptor-source an expression reads `.set` off, when the shape is
	 * readable: `{ key, all }` or null. Walks optional chains (`desc?.set`,
	 * `Object.getOwnPropertyDescriptor(…)?.set`) and parenthesization.
	 */
	const descriptorSetSource = (node) => {
		let current = unwrapParen(node);
		// Peel one `.set` access — with or without the optional-chain token.
		const access = propertyName(current);
		if (!access || access.computed || access.name !== 'set') return null;
		const base = unwrapParen(access.object);
		if (ts.isIdentifier(base) && descriptorNames.has(base.text))
			return descriptorNames.get(base.text);
		return isDescriptorLookupCall(base);
	};
	const descriptorSetFindings = (source, invocationText) => {
		if (source.all || source.key === null)
			return [
				`${file} invokes a property-descriptor setter ${invocationText} whose property this reading cannot fold — the descriptor could be the innerHTML/srcdoc setter, an alternate raw-HTML sink`,
			];
		if (RAW_HTML_WRITE_PROPERTY.has(source.key) || DANGEROUS_METHOD_NAMES.includes(source.key))
			return [
				`${file} invokes a property-descriptor setter for '${source.key}' ${invocationText} — an alternate raw-HTML sink that bypasses {@html} scanning`,
			];
		return [];
	};

	descriptorSetterExtractions();

	// R7-4: MULTI-STEP METHOD BINDING. `const m = host.insertAdjacentHTML;
	// const inj = m.bind(host); inj('afterbegin', html)` launders the method
	// through a bound copy two declarations away. Alias resolution is a fixed
	// point over identifier references and `.bind` results, so any number of
	// intermediate names resolve to the extracted method.
	const methodAliasSeeds = new Map(); // name -> initializer node
	eachNode(sourceFile, (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			if (ts.isIdentifier(node.name) && !methodAliasSeeds.has(node.name.text))
				methodAliasSeeds.set(node.name.text, node.initializer);
			return;
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			!methodAliasSeeds.has(node.left.text)
		)
			methodAliasSeeds.set(node.left.text, node.right);
	});
	const resolveMethodAliasFrom = (node, seen) => {
		const inner = unwrapParen(node);
		if (!inner) return null;
		const direct = dangerousMethodName(inner);
		if (direct) return direct;
		if (ts.isIdentifier(inner)) {
			if (seen.has(inner.text)) return null;
			seen.add(inner.text);
			if (dangerousMethodAliases.has(inner.text)) return dangerousMethodAliases.get(inner.text);
			const seed = methodAliasSeeds.get(inner.text);
			if (seed) return resolveMethodAliasFrom(seed, seen);
			return null;
		}
		// `X.bind(thisArg, …)` — the bound copy IS the method; the bound
		// arguments are re-prepended at the call site, so the alias carries the
		// method name only, exactly like the direct extraction.
		if (
			ts.isCallExpression(inner) &&
			ts.isPropertyAccessExpression(inner.expression) &&
			inner.expression.name.text === 'bind'
		)
			return resolveMethodAliasFrom(inner.expression.expression, seen);
		return null;
	};
	{
		let grew = true;
		while (grew) {
			grew = false;
			for (const [name, seed] of methodAliasSeeds) {
				if (dangerousMethodAliases.has(name)) continue;
				const method = resolveMethodAliasFrom(seed, new Set());
				if (method) {
					dangerousMethodAliases.set(name, method);
					grew = true;
				}
			}
		}
	}

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
					const key = sourcePropertyKey(property);
					if (key !== null) keys.add(key);
				}
				adoptKeys(bound, keys);
			});
		}
	}

	// R6-3: aliases of dangerous BUILT-IN callees — `const A = Object.assign;`
	// launders the callee so a receiver-first reading sees an identifier, and
	// `const { assign } = Object` does the same through a destructure. Each
	// alias is recorded with the builtin KIND so the call site runs the same
	// argument logic the direct spelling runs. execCommand is command-gated:
	// the destructure or extraction alone is inert, and only a call with an
	// insertHTML command (or an unfoldable one) is a finding — `ex('copy')`
	// stays clean.
	const dangerousBuiltinAliases = new Map();
	const builtinKind = (node) => {
		const access = propertyName(node);
		if (!access || access.computed) return null;
		if (
			ts.isIdentifier(access.object) &&
			access.object.text === 'Object' &&
			['assign', 'defineProperty', 'defineProperties'].includes(access.name)
		)
			return access.name;
		if (ts.isIdentifier(access.object) && access.object.text === 'Reflect' && access.name === 'set')
			return 'reflectSet';
		// R7-4: `Reflect.apply(Object.assign, null, [host, { innerHTML: html }])`
		// and `Reflect.construct(…)` dispatch into a callee the receiver-first
		// reading never sees — the callee is an ARGUMENT. Both are modeled as
		// builtin kinds so aliases, `.call/.apply` routes, and payload arrays
		// run through the same dispatch logic.
		if (
			ts.isIdentifier(access.object) &&
			access.object.text === 'Reflect' &&
			access.name === 'apply'
		)
			return 'reflectApply';
		if (
			ts.isIdentifier(access.object) &&
			access.object.text === 'Reflect' &&
			access.name === 'construct'
		)
			return 'reflectConstruct';
		if (access.name === 'execCommand') return 'execCommand';
		if (access.name === 'setAttribute' || access.name === 'setAttributeNS') return access.name;
		return null;
	};
	const bindBuiltinAlias = (name, kind) => {
		if (!dangerousBuiltinAliases.has(name)) dangerousBuiltinAliases.set(name, kind);
	};
	eachNode(sourceFile, (node) => {
		if (!ts.isVariableDeclaration(node) || !node.initializer) return;
		if (ts.isIdentifier(node.name)) {
			const init = unwrapParen(node.initializer);
			let kind = builtinKind(init);
			// `const A = Object.assign.bind(null);` — a .bind extraction is the
			// same callee laundering; the bound thisArg is dropped at the call
			// site.
			if (
				!kind &&
				ts.isCallExpression(init) &&
				ts.isPropertyAccessExpression(init.expression) &&
				init.expression.name.text === 'bind' &&
				init.arguments.length <= 1
			)
				kind = builtinKind(unwrapParen(init.expression.expression));
			if (kind) bindBuiltinAlias(node.name.text, kind);
			return;
		}
		if (!ts.isObjectBindingPattern(node.name)) return;
		// `const { assign: A } = Object;` / `const { execCommand } = document;`
		// — a destructured builtin/method extraction. Object and Reflect bind
		// builtin kinds; an execCommand or setAttribute destructure off any
		// receiver binds the command/key-gated kinds.
		const receiver = unwrapParen(node.initializer);
		for (const element of node.name.elements) {
			if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
			const property = element.propertyName ?? element.name;
			const key = ts.isIdentifier(property) ? property.text : foldPropertyKey(property);
			if (key === null || !ts.isIdentifier(element.name)) continue;
			let extracted = null;
			if (
				ts.isIdentifier(receiver) &&
				receiver.text === 'Object' &&
				['assign', 'defineProperty', 'defineProperties'].includes(key)
			)
				extracted = key;
			else if (ts.isIdentifier(receiver) && receiver.text === 'Reflect' && key === 'set')
				extracted = 'reflectSet';
			else if (key === 'execCommand') extracted = 'execCommand';
			else if (key === 'setAttribute' || key === 'setAttributeNS') extracted = key;
			if (extracted) bindBuiltinAlias(element.name.text, extracted);
		}
	});

	// R6-3 fixed point: payload keys carried by LOCAL FUNCTION RETURNS and by
	// ARRAYS, to the same fixed point objectLiteralKeys reaches for identifiers.
	// `const payload = () => ({ srcdoc: html }); Object.assign(frame, payload())`
	// hides the key in a call result; `const spreads = [{ srcdoc: html }];
	// Object.assign(frame, ...spreads)` hides it behind a rest spread. A return
	// or array this reading cannot resolve is UNKNOWN, and the Object.assign
	// walk fails closed on an unknown payload into a receiver it cannot prove is
	// a container.
	const localFunctionNodes = new Map();
	const functionReturnKeys = new Map(); // name -> { keys: Set, uncertain: boolean }
	const arrayPayloadKeys = new Map(); // name -> Set<keys> | null (null = unresolvable elements)
	{
		const collectReturnKeys = (fnNode) => {
			const keys = new Set();
			let anyReturn = false;
			let uncertain = false;
			const resolveExpr = (expr) => {
				const inner = unwrapParen(expr);
				if (ts.isObjectLiteralExpression(inner)) {
					for (const property of inner.properties) {
						if (ts.isSpreadAssignment(property)) {
							const spread = unwrapParen(property.expression);
							const from =
								(ts.isIdentifier(spread) &&
									objectLiteralKeys.has(spread.text) &&
									objectLiteralKeys.get(spread.text)) ||
								(ts.isIdentifier(spread) &&
									functionReturnKeys.has(spread.text) &&
									functionReturnKeys.get(spread.text).keys);
							if (from) {
								for (const key of from) keys.add(key);
							} else uncertain = true;
							continue;
						}
						const key = sourcePropertyKey(property);
						if (key === null) uncertain = true;
						else keys.add(key);
					}
					return;
				}
				if (ts.isIdentifier(inner)) {
					if (objectLiteralKeys.has(inner.text)) {
						for (const key of objectLiteralKeys.get(inner.text)) keys.add(key);
						return;
					}
					if (functionReturnKeys.has(inner.text)) {
						for (const key of functionReturnKeys.get(inner.text).keys) keys.add(key);
						return;
					}
					uncertain = true;
					return;
				}
				// A call of a local payload-returning function — `() => payload()`.
				if (
					ts.isCallExpression(inner) &&
					ts.isIdentifier(inner.expression) &&
					functionReturnKeys.has(inner.expression.text)
				) {
					const calleeResult = functionReturnKeys.get(inner.expression.text);
					for (const key of calleeResult.keys) keys.add(key);
					if (calleeResult.uncertain) uncertain = true;
					return;
				}
				// A provably non-object return (a string, a number, null, …) is
				// not an object payload and adds no keys and no uncertainty.
				if (
					ts.isStringLiteral(inner) ||
					ts.isNumericLiteral(inner) ||
					inner.kind === ts.SyntaxKind.TrueKeyword ||
					inner.kind === ts.SyntaxKind.FalseKeyword ||
					inner.kind === ts.SyntaxKind.NullKeyword ||
					inner.kind === ts.SyntaxKind.UndefinedKeyword ||
					(ts.isPrefixUnaryExpression(inner) &&
						(inner.operator === ts.SyntaxKind.MinusToken ||
							inner.operator === ts.SyntaxKind.PlusToken) &&
						ts.isNumericLiteral(inner.operand))
				)
					return;
				uncertain = true;
			};
			const body = fnNode.body;
			if (ts.isArrowFunction(fnNode) && body && !ts.isBlock(body)) {
				anyReturn = true;
				resolveExpr(body);
			} else if (body && ts.isBlock(body)) {
				const visitReturns = (node, top = true) => {
					if (!node || typeof node !== 'object') return;
					if (
						!top &&
						(ts.isFunctionDeclaration(node) ||
							ts.isArrowFunction(node) ||
							ts.isFunctionExpression(node) ||
							ts.isMethodDeclaration(node))
					)
						return;
					if (ts.isReturnStatement(node)) {
						anyReturn = true;
						if (node.expression) resolveExpr(node.expression);
						else uncertain = true;
						return;
					}
					ts.forEachChild(node, (child) => visitReturns(child, false));
				};
				visitReturns(body);
			}
			if (!anyReturn) return { keys: new Set(), uncertain: true };
			return { keys, uncertain };
		};
		const setsEqual = (a, b) => a.size === b.size && [...a].every((key) => b.has(key));
		let grew = true;
		while (grew) {
			grew = false;
			eachNode(sourceFile, (node) => {
				if (ts.isFunctionDeclaration(node) && node.name)
					localFunctionNodes.set(node.name.text, node);
				if (
					ts.isVariableDeclaration(node) &&
					ts.isIdentifier(node.name) &&
					node.initializer &&
					(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
				)
					localFunctionNodes.set(node.name.text, node.initializer);
			});
			for (const [name, fnNode] of localFunctionNodes) {
				const before = functionReturnKeys.get(name);
				const after = collectReturnKeys(fnNode);
				if (
					!before ||
					before.uncertain !== after.uncertain ||
					!setsEqual(before.keys, after.keys)
				) {
					functionReturnKeys.set(name, after);
					grew = true;
				}
			}
			eachNode(sourceFile, (node) => {
				if (
					!ts.isVariableDeclaration(node) ||
					!ts.isIdentifier(node.name) ||
					!node.initializer ||
					arrayPayloadKeys.has(node.name.text)
				)
					return;
				const inner = unwrapParen(node.initializer);
				if (!ts.isArrayLiteralExpression(inner)) return;
				const keys = new Set();
				let resolvable = true;
				for (const element of inner.elements) {
					if (ts.isSpreadElement(element)) {
						const spread = unwrapParen(element.expression);
						if (ts.isIdentifier(spread) && arrayPayloadKeys.has(spread.text)) {
							const from = arrayPayloadKeys.get(spread.text);
							if (from === null) {
								resolvable = false;
								break;
							}
							for (const key of from) keys.add(key);
							continue;
						}
						resolvable = false;
						break;
					}
					const el = unwrapParen(element);
					if (ts.isObjectLiteralExpression(el)) {
						let elementResolvable = true;
						for (const property of el.properties) {
							if (ts.isSpreadAssignment(property)) {
								elementResolvable = false;
								break;
							}
							const folded = sourcePropertyKey(property);
							if (folded === null) {
								elementResolvable = false;
								break;
							}
							keys.add(folded);
						}
						if (!elementResolvable) {
							resolvable = false;
							break;
						}
						continue;
					}
					resolvable = false;
					break;
				}
				arrayPayloadKeys.set(node.name.text, resolvable ? keys : null);
				grew = true;
			});
		}
	}

	// R6-3: the shared verdicts for dangerous builtin calls, so the direct
	// spellings and their aliases/.call/.apply/.bind routes run one logic.
	// `shift` is 0 for a direct call and 1 for a call routed through
	// `.call(...)`/`.apply(...)` where the first argument is the thisArg.
	const assignFindings = (receiver, sources) => {
		const out = [];
		if (receiver && isDocumentObject(receiver)) {
			out.push(
				`${file} calls Object.assign on the document object — it can write raw-HTML properties`
			);
			return out;
		}
		const receiverIsContainer = Boolean(
			receiver && (receiverCleared(receiver) || isContainerExpression(receiver))
		);
		const elementKeysOfArrayLiteral = (array) => {
			const keys = new Set();
			for (const element of array.elements) {
				if (ts.isSpreadElement(element)) {
					const inner = unwrapParen(element.expression);
					if (ts.isIdentifier(inner) && arrayPayloadKeys.has(inner.text)) {
						const from = arrayPayloadKeys.get(inner.text);
						if (from === null) return null;
						for (const key of from) keys.add(key);
						continue;
					}
					return null;
				}
				const el = unwrapParen(element);
				if (ts.isObjectLiteralExpression(el)) {
					for (const property of el.properties) {
						if (ts.isSpreadAssignment(property)) return null;
						const folded = sourcePropertyKey(property);
						if (folded === null) return null;
						keys.add(folded);
					}
					continue;
				}
				return null;
			}
			return keys;
		};
		for (const arg of sources) {
			if (ts.isSpreadElement(arg)) {
				const spread = unwrapParen(arg.expression);
				const arrayKeys = ts.isArrayLiteralExpression(spread)
					? elementKeysOfArrayLiteral(spread)
					: ts.isIdentifier(spread)
						? arrayPayloadKeys.get(spread.text)
						: undefined;
				if (arrayKeys !== undefined && arrayKeys !== null) {
					const laundered = [...arrayKeys].find((key) => RAW_HTML_PROPERTY.has(key));
					if (laundered)
						out.push(
							`${file} calls Object.assign with '${laundered}' carried by a spread payload — a laundered source can write a raw-HTML property`
						);
					continue;
				}
				if (!receiverIsContainer)
					out.push(
						`${file} calls Object.assign with an unresolvable spread payload — the spread could carry a raw-HTML property`
					);
				continue;
			}
			if (ts.isObjectLiteralExpression(arg)) {
				for (const property of arg.properties) {
					if (ts.isSpreadAssignment(property)) {
						const inner = unwrapParen(property.expression);
						if (ts.isIdentifier(inner) && objectLiteralKeys.has(inner.text)) {
							const laundered = [...objectLiteralKeys.get(inner.text)].find((key) =>
								RAW_HTML_PROPERTY.has(key)
							);
							if (laundered) {
								out.push(
									`${file} calls Object.assign with '${laundered}' carried by ${inner.text} — a laundered source object can write a raw-HTML property`
								);
								break;
							}
							continue;
						}
						if (!receiverIsContainer)
							out.push(
								`${file} calls Object.assign with a spread inside a source object this reading cannot resolve — it could carry a raw-HTML property`
							);
						continue;
					}
					const folded = sourcePropertyKey(property);
					if (folded !== null && RAW_HTML_PROPERTY.has(folded)) {
						out.push(
							`${file} calls Object.assign with '${folded}' in a source object — it can write a raw-HTML property`
						);
						break;
					}
					// R7-4: a computed key no static read can fold could be
					// 'innerHTML' itself. Into a receiver this reading cannot
					// prove a container, the position fails closed — the
					// constant-folded spelling above is the one cleared route.
					if (folded === null && sourceKeyComputed(property) && !receiverIsContainer) {
						out.push(
							`${file} calls Object.assign with a computed source key this reading cannot fold — it could write a raw-HTML property`
						);
						break;
					}
				}
				continue;
			}
			if (ts.isIdentifier(arg) && objectLiteralKeys.has(arg.text)) {
				const laundered = [...objectLiteralKeys.get(arg.text)].find((key) =>
					RAW_HTML_PROPERTY.has(key)
				);
				if (laundered)
					out.push(
						`${file} calls Object.assign with '${laundered}' carried by ${arg.text} — a laundered source object can write a raw-HTML property`
					);
				continue;
			}
			if (ts.isCallExpression(arg)) {
				const callee = unwrapParen(arg.expression);
				let resolved = null;
				if (ts.isIdentifier(callee) && localFunctionNodes.has(callee.text))
					resolved = functionReturnKeys.get(callee.text) ?? { keys: new Set(), uncertain: true };
				if (resolved) {
					const laundered = [...resolved.keys].find((key) => RAW_HTML_PROPERTY.has(key));
					if (laundered) {
						out.push(
							`${file} calls Object.assign with '${laundered}' returned by ${callee.text}() — a call-result payload can write a raw-HTML property`
						);
						continue;
					}
					if (!resolved.uncertain) continue; // provably clean return
				}
				if (!receiverIsContainer)
					out.push(
						`${file} calls Object.assign with an unresolvable call-result payload (${arg
							.getText(sourceFile)
							.slice(0, 60)}…) — it could carry a raw-HTML property`
					);
				continue;
			}
			// An identifier this reading never bound, or any other shape, keeps
			// the round-5 behaviour: left to the receiver-side and computed-key
			// rules, never guessed at.
		}
		return out;
	};
	const dispatchBuiltinCall = (kind, args, shift) => {
		const out = [];
		if (kind === 'assign') {
			out.push(...assignFindings(args[shift], args.slice(shift + 1)));
			return out;
		}
		if (kind === 'defineProperty') {
			const key = args[shift + 1];
			if (key === undefined) return out;
			const folded = foldLocalKey(key);
			if (folded === null || RAW_HTML_PROPERTY.has(folded))
				out.push(
					`${file} calls Object.defineProperty with ${
						folded === null ? 'a computed raw-HTML-capable key' : `'${folded}'`
					} — an alternate raw-HTML sink`
				);
			return out;
		}
		if (kind === 'defineProperties') {
			const descriptors = args[shift + 1];
			if (descriptors === undefined) return out;
			if (!ts.isObjectLiteralExpression(descriptors)) {
				out.push(
					`${file} calls Object.defineProperties with computed descriptors — they could define raw-HTML properties`
				);
				return out;
			}
			for (const descriptor of descriptors.properties) {
				const key =
					ts.isPropertyAssignment(descriptor) && ts.isComputedPropertyName(descriptor.name)
						? foldPropertyKey(descriptor.name.expression)
						: descriptor.name && ts.isIdentifier(descriptor.name)
							? descriptor.name.text
							: foldPropertyKey(descriptor.name);
				if (key === null || RAW_HTML_PROPERTY.has(key))
					out.push(
						`${file} calls Object.defineProperties with ${
							key === null ? 'a computed raw-HTML-capable key' : `'${key}'`
						} — an alternate raw-HTML sink`
					);
			}
			return out;
		}
		if (kind === 'reflectSet') {
			const key = args[shift + 1];
			if (key === undefined) return out;
			const folded = foldLocalKey(key);
			if (folded !== null) {
				if (RAW_HTML_PROPERTY.has(folded))
					out.push(
						`${file} calls Reflect.set with '${folded}' — an alternate raw-HTML sink that bypasses {@html} scanning`
					);
			} else {
				out.push(
					`${file} calls Reflect.set with a computed property key — it could set a raw-HTML property`
				);
			}
			return out;
		}
		if (kind === 'reflectApply') {
			// R7-4: `Reflect.apply(target, thisArg, argsArray)`. The callee is an
			// argument, so the reading resolves it — a dangerous builtin alias, a
			// dangerous method alias, or a builtin access — and dispatches the
			// payload array through that callee's own logic. A target or payload
			// the reading cannot resolve fails closed.
			const target = args[shift];
			const payload = args[shift + 2];
			const payloadElements =
				payload && ts.isArrayLiteralExpression(payload) ? payload.elements : null;
			if (!payload || payloadElements === null) {
				out.push(
					`${file} calls Reflect.apply with an argument array this reading cannot expand — the dispatched call could be a raw-HTML primitive`
				);
				return out;
			}
			const targetInner = unwrapParen(target);
			const targetAlias = ts.isIdentifier(targetInner)
				? (dangerousBuiltinAliases.get(targetInner.text) ??
					(dangerousMethodAliases.has(targetInner.text)
						? `method:${dangerousMethodAliases.get(targetInner.text)}`
						: undefined))
				: undefined;
			const targetKind = targetAlias ?? builtinKind(targetInner);
			if (targetKind === undefined || targetKind === null) {
				out.push(
					`${file} calls Reflect.apply with a callee this reading cannot resolve — it could dispatch into a raw-HTML primitive`
				);
				return out;
			}
			if (typeof targetKind === 'string' && targetKind.startsWith('method:')) {
				out.push(
					`${file} dispatches .${targetKind.slice('method:'.length)} through Reflect.apply — an alternate raw-HTML primitive`
				);
				return out;
			}
			out.push(...dispatchBuiltinCall(targetKind, payloadElements, 0));
			return out;
		}
		if (kind === 'reflectConstruct') {
			// R7-4: `Reflect.construct(Ctor, payload)`. The constructor is an
			// argument, and a constructor receives the payload as its arguments.
			// Constructors this reading can prove hold data rather than write DOM
			// stay clean; anything else fails closed.
			const BENIGN_CONSTRUCTORS = new Set([
				'Object',
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
				'Error',
				'TypeError',
				'RangeError',
				'SyntaxError',
				'ReferenceError',
				'Date',
				'RegExp',
				'Promise',
			]);
			const target = unwrapParen(args[shift]);
			if (ts.isIdentifier(target) && BENIGN_CONSTRUCTORS.has(target.text)) return out;
			out.push(
				`${file} calls Reflect.construct with a constructor this reading cannot prove benign — the payload array could feed a DOM writer`
			);
			return out;
		}
		if (kind === 'execCommand') {
			const command = foldLocalKey(args[shift]);
			if (command === null)
				out.push(
					`${file} calls .execCommand with a computed command — the command could be 'insertHTML', a legacy raw-HTML insertion`
				);
			else if (command.toLowerCase() === 'inserthtml')
				out.push(
					`${file} calls .execCommand('insertHTML', …) — a legacy raw-HTML insertion primitive that bypasses {@html} scanning`
				);
			return out;
		}
		if (kind === 'setAttribute' || kind === 'setAttributeNS') {
			const keyArgument = args[shift + (kind === 'setAttributeNS' ? 1 : 0)];
			const key = foldLocalKey(keyArgument);
			if (key === null || key.toLowerCase() === 'srcdoc')
				out.push(
					`${file} calls .${kind}(…) with ${
						key === null ? 'a computed key that could be srcdoc' : `'${key}'`
					} — an alternate raw-HTML sink`
				);
			return out;
		}
		return out;
	};

	eachNode(sourceFile, (node) => {
		if (ts.isBinaryExpression(node)) {
			const operator = node.operatorToken.kind;
			if (!isAssignmentToken(operator)) return;
			let access = propertyName(node.left);
			// R7-4: an element-access key bound to a constant string names the
			// same property the literal spelling does — `const k = 'innerHTML';
			// host[k] = html` — so it is folded before the computed position
			// fails closed.
			if (access && access.computed && ts.isElementAccessExpression(node.left)) {
				const folded = foldLocalKey(node.left.argumentExpression);
				if (folded !== null) access = { name: folded, object: access.object, computed: false };
			}
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
			let access = propertyName(node.operand);
			if (access && access.computed && ts.isElementAccessExpression(node.operand)) {
				const folded = foldLocalKey(node.operand.argumentExpression);
				if (folded !== null) access = { name: folded, object: access.object, computed: false };
			}
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
			let callee = propertyName(node.expression);
			if (callee && callee.computed && ts.isElementAccessExpression(node.expression)) {
				const folded = foldLocalKey(node.expression.argumentExpression);
				if (folded !== null) callee = { name: folded, object: callee.object, computed: false };
			}
			if (ts.isIdentifier(node.expression) && dangerousMethodAliases.has(node.expression.text)) {
				findings.push(
					`${file} calls an alias of .${dangerousMethodAliases.get(node.expression.text)}(…) — an alternate raw-HTML primitive`
				);
				return;
			}
			// R6-3: an alias of a dangerous BUILT-IN — `const A = Object.assign;
			// A(frame, { srcdoc })` runs the same argument logic the direct
			// spelling runs, and `const ex = document.execCommand; ex('copy')`
			// stays clean because the command gate is part of that logic.
			if (ts.isIdentifier(node.expression) && dangerousBuiltinAliases.has(node.expression.text)) {
				findings.push(
					...dispatchBuiltinCall(
						dangerousBuiltinAliases.get(node.expression.text),
						node.arguments,
						0
					)
				);
				return;
			}
			// R6-3: a call of a `.bind` result — `Object.assign.bind(null)(frame,
			// { srcdoc })`, and the same through an alias. The bound thisArg is
			// dropped; the remaining bound arguments are prepended.
			if (
				ts.isCallExpression(node.expression) &&
				ts.isPropertyAccessExpression(node.expression.expression) &&
				node.expression.expression.name.text === 'bind'
			) {
				const bound = node.expression;
				const inner = unwrapParen(bound.expression.expression);
				const kind =
					(ts.isIdentifier(inner) && dangerousBuiltinAliases.has(inner.text)
						? dangerousBuiltinAliases.get(inner.text)
						: null) ?? builtinKind(inner);
				if (kind) {
					findings.push(
						...dispatchBuiltinCall(kind, [...bound.arguments.slice(1), ...node.arguments], 0)
					);
					return;
				}
				// R7-4: the result of `.bind` on a dangerous METHOD alias —
				// `const m = host.insertAdjacentHTML; m.bind(host)('afterbegin', html)`
				// — and on an extracted descriptor setter.
				const method = resolveMethodAliasFrom(inner, new Set());
				if (method) {
					findings.push(
						`${file} invokes .${method} through a bound copy — an alternate raw-HTML primitive`
					);
					return;
				}
				const desc = descriptorSetSource(inner);
				if (desc) {
					findings.push(...descriptorSetFindings(desc, 'through .bind'));
					return;
				}
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
				if (callee.name === 'set' && descriptorSetSource(callee.object)) {
					// R7-4: a direct invocation of an extracted descriptor setter —
					// `desc.set(host, html)` / `Object.getOwnPropertyDescriptor(…)?.set?.(…)`.
					findings.push(...descriptorSetFindings(descriptorSetSource(callee.object), ''));
					return;
				}
				if (
					callee.name === 'insertAdjacentHTML' ||
					callee.name === 'createContextualFragment' ||
					callee.name === 'parseFromString' ||
					callee.name === 'setHTML' ||
					callee.name === 'setHTMLUnsafe' ||
					callee.name === 'setHTMLUnchecked'
				) {
					findings.push(
						`${file} calls .${callee.name}(…) — an alternate raw-HTML sink that bypasses {@html} scanning`
					);
					return;
				}
				if (callee.name === 'setAttribute' || callee.name === 'setAttributeNS') {
					findings.push(...dispatchBuiltinCall(callee.name, node.arguments, 0));
					return;
				}
				if (callee.name === 'execCommand') {
					// R5-4: the legacy document.execCommand family — `insertHTML` is
					// the raw-HTML insertion the round-5 review planted, and command
					// IDs are case-insensitive per the spec, so the folded command is
					// compared lowercased; a computed command fails closed. Other
					// commands (copy, bold, …) do not insert HTML.
					findings.push(...dispatchBuiltinCall('execCommand', node.arguments, 0));
					return;
				}
				if (
					callee.name === 'defineProperty' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Object'
				) {
					findings.push(...dispatchBuiltinCall('defineProperty', node.arguments, 0));
					return;
				}
				if (
					callee.name === 'defineProperties' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Object'
				) {
					findings.push(...dispatchBuiltinCall('defineProperties', node.arguments, 0));
					return;
				}
				if (
					callee.name === 'construct' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Reflect'
				) {
					// R7-4: `Reflect.construct(Ctor, payload)` — the constructor is
					// an argument the receiver-first reading never sees.
					findings.push(...dispatchBuiltinCall('reflectConstruct', node.arguments, 0));
					return;
				}
				if (callee.name === 'call' || callee.name === 'apply' || callee.name === 'bind') {
					// R7-4: `Reflect.apply(target, thisArg, args)` is NOT a
					// Function.prototype route — the callee is its FIRST ARGUMENT,
					// so it dispatches through its own logic instead of the
					// thisArg-shifted builtin logic below.
					if (ts.isIdentifier(callee.object) && callee.object.text === 'Reflect') {
						if (callee.name === 'apply') {
							findings.push(...dispatchBuiltinCall('reflectApply', node.arguments, 0));
						}
						return;
					}
					const method = dangerousMethodName(callee.object);
					if (method) {
						findings.push(
							`${file} invokes .${method} through .${callee.name}(…) — an alternate raw-HTML primitive`
						);
						return;
					}
					// R7-4: `.call/.apply/.bind` through a LAUNDERED method alias —
					// `const S = Element.prototype.setHTML; S.call(host, html)` — and
					// through an extracted descriptor setter, `Object
					// .getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set
					// ?.call(host, html)`.
					const aliased = resolveMethodAliasFrom(callee.object, new Set());
					if (aliased) {
						findings.push(
							`${file} invokes .${aliased} through .${callee.name}(…) — an alternate raw-HTML primitive`
						);
						return;
					}
					const desc = descriptorSetSource(callee.object);
					if (desc) {
						findings.push(...descriptorSetFindings(desc, `through .${callee.name}(…)`));
						return;
					}
					// R6-3: a dangerous builtin routed through .call/.apply — the
					// thisArg occupies the first argument, so the builtin's own
					// argument window shifts by one. An `apply` whose array is not a
					// literal cannot be expanded statically and fails closed on an
					// unproven receiver exactly as an unknown call-result payload does.
					const inner = unwrapParen(callee.object);
					const kind =
						(ts.isIdentifier(inner) && dangerousBuiltinAliases.has(inner.text)
							? dangerousBuiltinAliases.get(inner.text)
							: null) ?? builtinKind(inner);
					if (kind) {
						let args = node.arguments;
						if (
							callee.name === 'apply' &&
							node.arguments[1] &&
							ts.isArrayLiteralExpression(node.arguments[1])
						)
							args = node.arguments[1].elements;
						else if (callee.name === 'apply' && kind === 'assign')
							findings.push(
								`${file} applies Object.assign with a non-literal argument array — the payload could carry a raw-HTML property`
							);
						findings.push(...dispatchBuiltinCall(kind, args, callee.name === 'call' ? 1 : 0));
						return;
					}
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
					findings.push(...dispatchBuiltinCall('reflectSet', node.arguments, 0));
					return;
				}
				if (
					callee.name === 'assign' &&
					ts.isIdentifier(callee.object) &&
					callee.object.text === 'Object'
				) {
					findings.push(...dispatchBuiltinCall('assign', node.arguments, 0));
					return;
				}
				return;
			}
		}
		if (ts.isJsxAttribute(node)) {
			// HTML/JSX attribute names are case-insensitive — `<iframe srcDoc=…>`
			// and `<iframe SRCDOC=…>` both set srcdoc (round-5). React's
			// `dangerouslySetInnerHTML` is the JSX spelling of an un-sanitized
			// HTML write, so it fails here too (R6-3 residual: a narrow,
			// owned-source rule; a component that needs it belongs upstream).
			const lower = node.name.text.toLowerCase();
			if (lower === 'srcdoc' || lower === 'dangerouslysetinnerhtml') {
				findings.push(
					`${file} carries a ${node.name.text} attribute — an alternate raw-HTML sink that bypasses {@html} scanning`
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
	const arrayValueIndex = new Map(); // identifier -> Set<index> | 'any'
	const mapContainers = new Set();
	const previewReturning = new Set(); // callee names that return the value
	const importedNames = new Set();
	const functions = new Map(); // callee name -> [{ node, paramNames }]
	// R7-3: SETTERS a value-carrying container offers — `const box = { set
	// body(v) { … } }` plus `box.body = preview` hands the reference to the
	// setter's parameter, which then needs the same write analysis as any other
	// binding of the value. identifier -> Map<property | '*', paramName>.
	const containerSetters = new Map();
	// R7-3: local GENERATORS that yield the reference — `function* stream() {
	// yield preview; }` then `for (const p of stream())` binds p to the value
	// exactly as an array iteration would.
	const yieldCarrying = new Set();
	// R7-3: constant-string folding for COMPUTED keys — `const k = 'body';
	// holder[k].html = …` names the same property the literal spelling does.
	const constantStrings = new Map();
	eachNode(sourceFile, (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const literal = foldPropertyKey(node.initializer);
			if (literal !== null) constantStrings.set(node.name.text, literal);
		}
	});
	const foldLocalKey = (node) =>
		node && ts.isIdentifier(node) && constantStrings.has(node.text)
			? constantStrings.get(node.text)
			: foldPropertyKey(node);

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
		// R6-2: CLASS constructors are functions for the mutating-parameter
		// analysis — `class Mangler { constructor(p) { p.html = … } }; new
		// Mangler(preview)` hands the value to a constructor whose parameter is
		// written. A constructor-less class declares no parameters and can never
		// be mutating, so `new Empty(preview)` stays green. R7-3 exception: a
		// constructor-less class WITH A HERITAGE CLAUSE runs the INHERITED
		// constructor — `class Wrap extends Mangler {}` hands the value to a
		// constructor this file never declares, which no local reading can prove
		// clean; those classes record `paramNames: null` (unproven) instead of
		// the empty list.
		if (ts.isClassDeclaration(node) && node.name) {
			const ctor = node.members.find((member) => ts.isConstructorDeclaration(member)) ?? null;
			functions.set(node.name.text, [
				...(functions.get(node.name.text) ?? []),
				{
					node: ctor ?? node,
					paramNames: ctor
						? ctor.parameters.map((p) => p.name)
						: node.heritageClauses && node.heritageClauses.length > 0
							? null
							: [],
				},
			]);
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const init = unwrapValueNode(node.initializer);
			if (init && ts.isClassExpression(init)) {
				const ctor = init.members.find((member) => ts.isConstructorDeclaration(member)) ?? null;
				functions.set(node.name.text, [
					...(functions.get(node.name.text) ?? []),
					{
						node: ctor ?? init,
						paramNames: ctor
							? ctor.parameters.map((p) => p.name)
							: init.heritageClauses && init.heritageClauses.length > 0
								? null
								: [],
					},
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

	/**
	 * R6-2: whether a GETTER's return can carry the preview reference. A return
	 * that provably IS the value (an identifier bound to it, a read of a
	 * container property that holds it) makes the property a carrier; a return
	 * that is provably a fresh value — a literal, an object or array literal —
	 * is not the preview reference; anything else cannot be proven direct and
	 * fails closed as a carrier. "If the returned property can carry preview and
	 * cannot be proven direct, reject."
	 */
	const getterCanCarry = (accessor) => {
		const body = accessor.body;
		if (!body) return false;
		let carries = false;
		const visit = (n, top = true) => {
			if (carries || !n || typeof n !== 'object') return;
			if (
				!top &&
				(ts.isFunctionDeclaration(n) ||
					ts.isArrowFunction(n) ||
					ts.isFunctionExpression(n) ||
					ts.isMethodDeclaration(n))
			)
				return;
			if (ts.isReturnStatement(n)) {
				if (!n.expression) return; // bare return — undefined, not the reference
				const expr = unwrapValueNode(n.expression);
				if (holdsValue(expr)) {
					carries = true;
					return;
				}
				if (
					ts.isStringLiteral(expr) ||
					ts.isNumericLiteral(expr) ||
					expr.kind === ts.SyntaxKind.TrueKeyword ||
					expr.kind === ts.SyntaxKind.FalseKeyword ||
					expr.kind === ts.SyntaxKind.NullKeyword ||
					expr.kind === ts.SyntaxKind.UndefinedKeyword ||
					(ts.isPrefixUnaryExpression(expr) &&
						(expr.operator === ts.SyntaxKind.MinusToken ||
							expr.operator === ts.SyntaxKind.PlusToken) &&
						ts.isNumericLiteral(expr.operand)) ||
					ts.isObjectLiteralExpression(expr) ||
					ts.isArrayLiteralExpression(expr)
				)
					return; // provably a fresh, non-preview value
				carries = true; // unknown — fail closed
				return;
			}
			ts.forEachChild(n, (child) => visit(child, false));
		};
		visit(body);
		return carries;
	};

	/**
	 * The value-carrying property keys of an object literal, INCLUDING accessors
	 * (R6-2): `const box = { get body() { return preview; } }` makes `body` a
	 * carrier read. `{ props, holds }` — `holds` is false when no property of
	 * the literal carries the value, so a getter returning a string builds no
	 * container record and `box.title.html = …` stays clean.
	 */
	const objectLiteralCarriedProps = (inner) => {
		const props = new Set();
		const setters = new Map(); // property | '*' -> setter parameter name
		let holds = false;
		for (const property of inner.properties) {
			if (ts.isSpreadAssignment(property)) continue;
			let key = null;
			let valueExpr = null;
			if (ts.isPropertyAssignment(property)) {
				key = ts.isComputedPropertyName(property.name)
					? foldLocalKey(property.name.expression)
					: ts.isIdentifier(property.name)
						? property.name.text
						: ts.isStringLiteral(property.name)
							? property.name.text
							: null;
				valueExpr = property.initializer;
			} else if (ts.isShorthandPropertyAssignment(property)) {
				key = property.name.text;
				valueExpr = property.name;
			} else if (ts.isGetAccessorDeclaration(property)) {
				if (ts.isIdentifier(property.name)) key = property.name.text;
				else if (ts.isStringLiteral(property.name)) key = property.name.text;
				else if (ts.isComputedPropertyName(property.name))
					key = foldLocalKey(property.name.expression);
				if (getterCanCarry(property)) {
					holds = true;
					props.add(key ?? '*');
				}
				continue;
			} else if (ts.isSetAccessorDeclaration(property)) {
				// R7-3: a SETTER receives whatever is assigned to its property —
				// `box.body = preview` hands the reference to the parameter, which
				// can then write `.html` on it. The parameter is bound as a value
				// name when a value-carrying assignment targets the property.
				if (ts.isIdentifier(property.name)) key = property.name.text;
				else if (ts.isStringLiteral(property.name)) key = property.name.text;
				else if (ts.isComputedPropertyName(property.name))
					key = foldLocalKey(property.name.expression);
				const param = property.parameters[0];
				const paramName = param && ts.isIdentifier(param.name) ? param.name.text : null;
				if (paramName) setters.set(key ?? '*', paramName);
				continue;
			}
			if (valueExpr && holdsValue(valueExpr)) {
				holds = true;
				props.add(key ?? '*');
			}
		}
		return { props, holds, setters };
	};

	/** The property key a destructure element reads, or null when computed. */
	const destructureKey = (element) => {
		if (!ts.isBindingElement(element)) return null;
		const property = element.propertyName ?? element.name;
		if (ts.isIdentifier(property)) return property.text;
		if (ts.isStringLiteral(property)) return property.text;
		if (ts.isComputedPropertyName(property)) return null;
		return null;
	};

	/**
	 * The property key an ASSIGNMENT-pattern element reads — `({ body: shadow }
	 * = holder)` carries the key in a PropertyAssignment's name, `({ body } =
	 * holder)` in a shorthand's. Null when computed.
	 */
	const assignmentKeyOf = (element) => {
		if (ts.isPropertyAssignment(element)) {
			if (ts.isIdentifier(element.name)) return element.name.text;
			if (ts.isStringLiteral(element.name)) return element.name.text;
			if (ts.isComputedPropertyName(element.name)) return null;
			return null;
		}
		if (ts.isShorthandPropertyAssignment(element)) return element.name.text;
		return null;
	};

	/**
	 * Normalize a destructure pattern — a BindingPattern for a declaration, an
	 * Object/Array LITERAL for an assignment — into `{ key, target, isRest }`
	 * elements, so one binding routine serves both spellings (R6-2).
	 */
	const patternElementsOf = (pattern) => {
		const items = ts.isObjectLiteralExpression(pattern) ? pattern.properties : pattern.elements;
		const out = [];
		for (const element of items) {
			if (ts.isBindingElement(element)) {
				out.push({
					key: element.dotDotDotToken ? null : destructureKey(element),
					target: element.name,
					isRest: Boolean(element.dotDotDotToken),
					omitted: ts.isOmittedExpression(element.name),
				});
				continue;
			}
			if (ts.isOmittedExpression(element)) {
				out.push({ key: null, target: element, isRest: false, omitted: true });
				continue;
			}
			if (ts.isPropertyAssignment(element)) {
				out.push({
					key: assignmentKeyOf(element),
					target: element.initializer,
					isRest: false,
					omitted: false,
				});
				continue;
			}
			if (ts.isShorthandPropertyAssignment(element)) {
				out.push({ key: element.name.text, target: element.name, isRest: false, omitted: false });
				continue;
			}
			if (ts.isSpreadAssignment(element)) {
				out.push({ key: null, target: element.expression, isRest: true, omitted: false });
				continue;
			}
			if (ts.isSpreadElement(element)) {
				out.push({ key: null, target: element.expression, isRest: true, omitted: false });
				continue;
			}
			if (ts.isIdentifier(element)) {
				out.push({ key: element.text, target: element, isRest: false, omitted: false });
				continue;
			}
		}
		return out;
	};

	/**
	 * The value-carrying props a destructure initializer offers: the recorded
	 * container paths of an identifier, or the carried props of an object
	 * literal written inline. Null when the initializer is not a known
	 * value-carrying container.
	 */
	const containerPropsOf = (expr) => {
		const inner = unwrapValueNode(expr);
		if (ts.isIdentifier(inner)) return containerPaths.get(inner.text) ?? null;
		if (ts.isObjectLiteralExpression(inner)) {
			const carried = objectLiteralCarriedProps(inner);
			return carried.holds ? carried.props : null;
		}
		return null;
	};

	/**
	 * The array positions that hold the preview reference: a Set of indices for
	 * an array literal or a literal-bound name, `'any'` when a spread or a
	 * mutation method could place the value anywhere, or null when the array is
	 * not a known value carrier.
	 */
	const arrayHoldingIndices = (expr) => {
		const inner = unwrapValueNode(expr);
		if (ts.isArrayLiteralExpression(inner)) {
			const indices = new Set();
			let any = false;
			inner.elements.forEach((element, index) => {
				if (ts.isSpreadElement(element)) {
					if (arrayHoldsValue(element.expression)) any = true;
					return;
				}
				if (holdsValue(element)) indices.add(index);
			});
			return any ? 'any' : indices;
		}
		if (ts.isIdentifier(inner)) {
			if (arrayValueIndex.has(inner.text)) return arrayValueIndex.get(inner.text);
			if (arrayContainers.has(inner.text)) return 'any';
			return null;
		}
		return null;
	};

	/** Whether an expression provably holds the preview reference. */
	const holdsValue = (expr) => {
		if (!expr) return false;
		const inner = unwrapValueNode(expr);
		// R8-2: `await` resolves to the awaited expression's fulfillment value —
		// `await relayAsync(preview)` IS the reference the relay returns, so the
		// identity survives the await exactly as it survives the call.
		if (ts.isAwaitExpression(inner)) return holdsValue(inner.expression);
		if (ts.isIdentifier(inner)) return valueNames.has(inner.text);
		if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
			const props = containerPaths.get(inner.expression.text);
			return Boolean(props && (props.has(inner.name.text) || props.has('*')));
		}
		if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
			if (arrayContainers.has(inner.expression.text) || mapContainers.has(inner.expression.text))
				return true;
			// R7-3: element access on an OBJECT container — `holder['body']` with
			// the key folded through constant strings, and `holder[key]` with a
			// key no static read can fold: an unknown element of a container that
			// carries the reference could BE the reference, so the position fails
			// closed whenever the container carries at all.
			const props = containerPaths.get(inner.expression.text);
			if (props) {
				const folded = foldLocalKey(inner.argumentExpression);
				if (folded === null) return props.size > 0;
				return props.has(folded) || props.has('*');
			}
			return false;
		}
		if (ts.isCallExpression(inner)) {
			const rune = runeAliasArgument(inner);
			if (rune) return holdsValue(rune);
			if (ts.isIdentifier(inner.expression) && previewReturning.has(inner.expression.text))
				return true;
			// R8-2: `Promise.resolve(<value>)` fulfills with the value itself —
			// the expression carries the reference exactly as its argument does,
			// which is what lets a `.then` on it bind the callback's parameter.
			if (
				ts.isPropertyAccessExpression(inner.expression) &&
				ts.isIdentifier(inner.expression.expression) &&
				inner.expression.expression.text === 'Promise' &&
				inner.expression.name.text === 'resolve' &&
				inner.arguments.length === 1
			)
				return holdsValue(inner.arguments[0]);
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

	/** Whether an expression is an array that holds the value at some position. */
	const arrayHoldsValue = (expr) => {
		const indices = arrayHoldingIndices(expr);
		return indices === 'any' || (indices !== null && indices.size > 0);
	};

	/**
	 * R6-2: bind the names a destructure pattern extracts from a value-carrying
	 * container. `const { body: shadow } = holder` and `({ body: shadow } =
	 * holder)` bind shadow to the reference; a rest element carries anything not
	 * explicitly destructured; a computed key fails closed whenever the
	 * container carries the value at all. Array patterns use the recorded index
	 * positions, with a rest binding carrying any later position.
	 */
	const bindDestructure = (pattern, initializer) => {
		const isObjectPattern =
			ts.isObjectBindingPattern(pattern) || ts.isObjectLiteralExpression(pattern);
		const isArrayPattern =
			ts.isArrayBindingPattern(pattern) || ts.isArrayLiteralExpression(pattern);
		if (isObjectPattern) {
			const props = containerPropsOf(initializer);
			if (!props) return false;
			let grew = false;
			const elements = patternElementsOf(pattern);
			for (const element of elements) {
				if (element.omitted) continue;
				if (element.isRest) {
					// A rest element is a CONTAINER of the props it carries, not
					// the preview reference itself — `const { title, ...rest } =
					// holder` makes `rest.body` the preview read.
					if (!ts.isIdentifier(element.target)) continue;
					const explicit = new Set();
					for (const other of elements)
						if (!other.isRest && other.key !== null) explicit.add(other.key);
					const carriedProps = new Set(
						[...props].filter((key) => key !== '*' && !explicit.has(key))
					);
					const carries = props.has('*') || carriedProps.size > 0;
					if (carries && !containerPaths.has(element.target.text)) {
						containerPaths.set(element.target.text, props.has('*') ? new Set(['*']) : carriedProps);
						grew = true;
					}
					continue;
				}
				const carries =
					element.key === null ? props.size > 0 : props.has(element.key) || props.has('*');
				if (!carries) continue;
				for (const name of bindingNames(element.target)) {
					if (addValueName(name)) grew = true;
				}
			}
			return grew;
		}
		if (isArrayPattern) {
			const indices = arrayHoldingIndices(initializer);
			if (indices === null) return false;
			const any = indices === 'any';
			let grew = false;
			const elements = patternElementsOf(pattern);
			elements.forEach((element, index) => {
				if (element.omitted) return;
				if (element.isRest) {
					// A rest element is an ARRAY container of the positions after
					// it — `const [first, ...rest] = arr` makes `rest[0]` the
					// preview read, so rest joins the array containers.
					if (!ts.isIdentifier(element.target)) return;
					const carriesRest = any || [...indices].some((i) => i >= index);
					if (carriesRest && !arrayContainers.has(element.target.text)) {
						arrayContainers.add(element.target.text);
						arrayValueIndex.set(
							element.target.text,
							any ? 'any' : new Set([...indices].filter((i) => i >= index))
						);
						grew = true;
					}
					return;
				}
				if (any || indices.has(index))
					for (const name of bindingNames(element.target)) if (addValueName(name)) grew = true;
			});
			return grew;
		}
		return false;
	};

	/** Whether an expression is an array-like that holds the value. */
	/**
	 * R7-3: collection methods whose result CANNOT carry the reference —
	 * reductions to a scalar or to indices. Any OTHER method on a value-carrying
	 * array is a transform this reading cannot resolve, and an unresolved
	 * transform that could carry the reference fails closed.
	 */
	const ARRAY_REDUCE_METHODS = new Set([
		'join',
		'toString',
		'indexOf',
		'lastIndexOf',
		'includes',
		'some',
		'every',
		'findIndex',
		'findLastIndex',
		'forEach',
		'keys',
	]);
	const arrayRooted = (expr) => {
		const inner = unwrapValueNode(expr);
		if (ts.isIdentifier(inner))
			return arrayContainers.has(inner.text) || mapContainers.has(inner.text);
		if (ts.isArrayLiteralExpression(inner)) return arrayHoldsValue(inner);
		if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression))
			return arrayContainers.has(inner.expression.text) || mapContainers.has(inner.expression.text);
		if (ts.isCallExpression(inner)) {
			const callee = propertyName(inner.expression);
			if (callee && ts.isIdentifier(callee.object)) {
				if (
					mapContainers.has(callee.object.text) &&
					(callee.name === 'values' || callee.name === 'get')
				)
					return true;
				// R7-3: `Object.values(holder)` / `Object.entries(holder)` over a
				// value-carrying container iterate the reference itself.
				if (
					callee.object.text === 'Object' &&
					(callee.name === 'values' || callee.name === 'entries') &&
					inner.arguments[0]
				) {
					const target = unwrapValueNode(inner.arguments[0]);
					if (ts.isIdentifier(target)) {
						if (arrayContainers.has(target.text) || mapContainers.has(target.text)) return true;
						const props = containerPaths.get(target.text);
						if (props && props.size > 0) return true;
					}
					return false;
				}
			}
			if (callee && !callee.computed && arrayRooted(callee.object)) {
				if (!ARRAY_REDUCE_METHODS.has(callee.name)) return true;
				return false;
			}
			// R7-3: a local generator that yields the reference — `for (const p
			// of stream())` iterates it exactly as an array would.
			if (ts.isIdentifier(inner.expression) && yieldCarrying.has(inner.expression.text))
				return true;
			return false;
		}
		return false;
	};

	// --- fixed point: value names, containers, and returning functions -------
	let changed = true;
	while (changed) {
		changed = false;

		// Bindings and container records.
		eachNode(sourceFile, (node) => {
			// R6-2: a destructure from a value-carrying container — declaration
			// (`const { body: shadow } = holder;`) and assignment
			// (`({ body: shadow } = holder);`) patterns alike.
			if (
				ts.isVariableDeclaration(node) &&
				(ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) &&
				node.initializer
			) {
				if (bindDestructure(node.name, node.initializer)) changed = true;
				return;
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				(ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left))
			) {
				if (bindDestructure(node.left, node.right)) changed = true;
				return;
			}
			// R6-2: a for-of binding over a value-carrying array — `for (const
			// alias of [preview])` binds alias to the reference itself. R7-3
			// widens the iterable to everything `arrayRooted` reads as carrying:
			// transform results (`arr.map((p) => p)`), generator calls that yield
			// the reference, and `Object.values`/`Object.entries` over a carrying
			// container. An `Object.entries` element is a `[key, value]` pair, so
			// a binding pattern's leaf names all receive the reference — the
			// conservative spelling of "one of these is the value".
			if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
				const iterable = unwrapValueNode(node.expression);
				if (arrayHoldsValue(iterable) || arrayRooted(iterable)) {
					for (const declaration of node.initializer.declarations) {
						for (const name of bindingNames(declaration.name)) {
							if (addValueName(name)) changed = true;
						}
					}
				}
				return;
			}
			// R6-2: a catch binding of a thrown preview — `try { throw preview; }
			// catch (e) { e.html = … }` binds e to the reference.
			if (ts.isTryStatement(node)) {
				let throwsValue = false;
				const scanTry = (n, top = true) => {
					if (throwsValue || !n || typeof n !== 'object') return;
					if (
						!top &&
						(ts.isFunctionDeclaration(n) ||
							ts.isArrowFunction(n) ||
							ts.isFunctionExpression(n) ||
							ts.isMethodDeclaration(n))
					)
						return;
					if (ts.isThrowStatement(n) && n.expression && holdsValue(n.expression)) {
						throwsValue = true;
						return;
					}
					ts.forEachChild(n, (child) => scanTry(child, false));
				};
				scanTry(node.tryBlock);
				if (
					throwsValue &&
					node.catchClause?.variableDeclaration &&
					ts.isIdentifier(node.catchClause.variableDeclaration.name) &&
					addValueName(node.catchClause.variableDeclaration.name.text)
				)
					changed = true;
				return;
			}
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
				const carried = objectLiteralCarriedProps(inner);
				// R7-3: a literal with SETTERS is a container even before it holds
				// the value — `set body(v)` receives whatever a later `box.body =
				// preview` assigns. Recording it lets the late-population reading
				// bind the setter parameter when that write happens.
				if ((carried.holds || carried.setters.size > 0) && !containerPaths.has(bound)) {
					containerPaths.set(bound, carried.props);
					if (carried.setters.size > 0) containerSetters.set(bound, carried.setters);
					changed = true;
				}
			} else if (ts.isArrayLiteralExpression(inner)) {
				const indices = arrayHoldingIndices(inner);
				if (indices !== null && !arrayContainers.has(bound)) {
					arrayContainers.add(bound);
					arrayValueIndex.set(bound, indices);
					changed = true;
				}
			}
		});

		// R6-2: array-iteration callbacks — `[preview].forEach((p) => { p.html =
		// … })` hands the reference to the callback's element parameter. The
		// array-iteration methods take the element as the first parameter (the
		// second for `reduce`, whose first is the accumulator).
		eachNode(sourceFile, (node) => {
			if (!ts.isCallExpression(node)) return;
			const callee = propertyName(node.expression);
			if (!callee || callee.computed) return;
			if (!ARRAY_ITERATION_METHODS.has(callee.name)) return;
			if (!arrayRooted(unwrapValueNode(callee.object))) return;
			const callback = node.arguments[0];
			if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
			const param = callback.parameters[callee.name === 'reduce' ? 1 : 0];
			if (!param) return;
			for (const name of bindingNames(param.name)) {
				if (addValueName(name)) changed = true;
			}
		});

		// R8-2: `.then` and `.catch` on a value-carrying expression hand the
		// reference to the callback's first parameter — `relayAsync(preview)
		// .then((p) => { p.html = … })` writes on the resolved value exactly as
		// a declaration read of the relay's result would. The receiver test
		// reads through awaits, preview-returning calls, and `Promise.resolve`,
		// so every promise wrapper of the reference is covered by the same
		// binding the direct spelling gets.
		eachNode(sourceFile, (node) => {
			if (!ts.isCallExpression(node)) return;
			const callee = propertyName(node.expression);
			if (!callee || callee.computed) return;
			if (callee.name !== 'then' && callee.name !== 'catch') return;
			if (!holdsValue(callee.object)) return;
			const callback = node.arguments[0];
			if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
			const param = callback.parameters[0];
			if (!param) return;
			for (const name of bindingNames(param.name)) {
				if (addValueName(name)) changed = true;
			}
		});

		// R8-2: CALL-SITE PARAMETER BINDING. When a call or `new` hands a
		// value-carrying argument to a LOCAL function, the callee's parameter
		// at that position holds the reference — it joins the value names, so a
		// `return p` marks the callee preview-returning, a write to `p.html`
		// inside the callee is caught by the write scan, and multi-hop chains
		// propagate one hop per fixed-point pass. A rest parameter receives any
		// argument from its position on; a destructured parameter's leaves are
		// references INTO the value and bind conservatively. Callees this
		// reading cannot resolve stay in the call scan's fail-closed branch.
		eachNode(sourceFile, (node) => {
			if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
			const args = node.arguments ?? [];
			if (!args.some((argument) => holdsValue(argument))) return;
			const calleeExpr = unwrapValueNode(node.expression);
			if (!ts.isIdentifier(calleeExpr)) return;
			const infos = functions.get(calleeExpr.text);
			if (!infos) return;
			for (const { node: fnNode, paramNames } of infos) {
				// `paramNames === null` is the unproven inherited constructor;
				// the call scan already fails closed on it, and no local parameter
				// exists to bind.
				if (paramNames === null) continue;
				const params = fnNode.parameters ?? [];
				for (let index = 0; index < params.length; index += 1) {
					const param = params[index];
					const carries = param.dotDotDotToken
						? args.slice(index).some((argument) => holdsValue(argument))
						: args[index] !== undefined && holdsValue(args[index]);
					if (!carries) continue;
					for (const name of bindingNames(param.name)) {
						if (addValueName(name)) changed = true;
					}
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

		// R7-3: LATE POPULATION — writes that place the reference into a container
		// AFTER its declaration, in every spelling: `stash.body = preview`,
		// `stash['body'] = preview`, `holder[k] = preview` (a key no static read
		// can fold places the value at an unknown property — recorded as '*'),
		// `arr[1] = preview`, and the `Object.assign`/`Reflect.set` spellings of
		// the same placement. A write onto a SETTER property additionally binds
		// the setter's parameter, which can then write `.html` on the reference.
		eachNode(sourceFile, (node) => {
			let target = null;
			let rhs = null;
			if (ts.isBinaryExpression(node) && isAssignmentToken(node.operatorToken.kind)) {
				target = node.left;
				rhs = node.right;
			} else if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression)
			) {
				// Object.assign(receiver, { body: preview }) / Reflect.set(receiver, key, preview)
				const object = node.expression.expression.text;
				const method = node.expression.name.text;
				if (object === 'Object' && method === 'assign' && ts.isIdentifier(node.arguments[0])) {
					const receiver = node.arguments[0].text;
					for (const source of node.arguments.slice(1)) {
						const src = unwrapValueNode(source);
						if (!ts.isObjectLiteralExpression(src)) {
							// A source this reading cannot read could set any
							// property — a placement at an unknown key. Provably
							// non-object literals (a string, a number) set nothing.
							if (
								ts.isStringLiteral(src) ||
								ts.isNumericLiteral(src) ||
								src.kind === ts.SyntaxKind.TrueKeyword ||
								src.kind === ts.SyntaxKind.FalseKeyword ||
								src.kind === ts.SyntaxKind.NullKeyword ||
								src.kind === ts.SyntaxKind.UndefinedKeyword
							)
								continue;
							const props = containerPaths.get(receiver) ?? new Set();
							if (!props.has('*')) {
								props.add('*');
								containerPaths.set(receiver, props);
								changed = true;
							}
							continue;
						}
						for (const property of src.properties) {
							if (ts.isSpreadAssignment(property)) {
								const props = containerPaths.get(receiver) ?? new Set();
								if (!props.has('*')) {
									props.add('*');
									containerPaths.set(receiver, props);
									changed = true;
								}
								continue;
							}
							const key = ts.isComputedPropertyName(property.name)
								? foldLocalKey(property.name.expression)
								: ts.isIdentifier(property.name)
									? property.name.text
									: ts.isStringLiteral(property.name)
										? property.name.text
										: null;
							const valueExpr = ts.isPropertyAssignment(property)
								? property.initializer
								: ts.isShorthandPropertyAssignment(property)
									? property.name
									: null;
							if (!valueExpr || !holdsValue(valueExpr)) continue;
							const props = containerPaths.get(receiver) ?? new Set();
							const record = key ?? '*';
							if (!props.has(record)) {
								props.add(record);
								containerPaths.set(receiver, props);
								changed = true;
							}
						}
					}
				}
				if (object === 'Reflect' && method === 'set' && ts.isIdentifier(node.arguments[0])) {
					const receiver = node.arguments[0].text;
					const key = foldLocalKey(node.arguments[1]);
					if (node.arguments[2] && holdsValue(node.arguments[2])) {
						const props = containerPaths.get(receiver) ?? new Set();
						const record = key ?? '*';
						if (!props.has(record)) {
							props.add(record);
							containerPaths.set(receiver, props);
							changed = true;
						}
					}
				}
				return;
			}
			if (!target || !rhs || !holdsValue(rhs)) return;
			const access = propertyName(target);
			if (!access) return;
			const receiver = unwrapValueNode(access.object);
			if (!ts.isIdentifier(receiver)) return;
			// A write THROUGH a value name is the write scan's finding, never a
			// container placement.
			if (valueNames.has(receiver.text)) return;
			let key;
			if (access.computed) {
				key = foldLocalKey(target.argumentExpression);
			} else {
				key = access.name;
			}
			const setters = containerSetters.get(receiver.text);
			if (setters) {
				const param = (key !== null && setters.get(key)) || setters.get('*');
				if (param && addValueName(param)) changed = true;
			}
			const numeric =
				key !== null && /^(0|[1-9][0-9]*)$/.test(key) && !containerPaths.has(receiver.text);
			if (numeric || arrayContainers.has(receiver.text)) {
				// An array placement — the value sits at the folded index, or
				// anywhere an unfolded key can reach.
				const wasArray = arrayContainers.has(receiver.text);
				if (!wasArray) {
					arrayContainers.add(receiver.text);
					changed = true;
				}
				const existing = arrayValueIndex.get(receiver.text);
				if (existing !== 'any') {
					if (key === null) {
						arrayValueIndex.set(receiver.text, 'any');
						changed = true;
					} else {
						const indices = existing instanceof Set ? existing : new Set();
						if (!indices.has(Number(key))) {
							indices.add(Number(key));
							arrayValueIndex.set(receiver.text, indices);
							changed = true;
						}
					}
				}
				return;
			}
			const props = containerPaths.get(receiver.text) ?? new Set();
			const record = key ?? '*';
			if (!props.has(record)) {
				props.add(record);
				containerPaths.set(receiver.text, props);
				changed = true;
			}
		});

		// R7-3: COLLECTION TRANSFORMS. `const ys = arr.map((p) => p)` carries the
		// reference into the result; `filter`/`flatMap` can too, and a transform
		// this reading cannot resolve is treated as carrying — an unresolved
		// transform over a value-carrying array fails closed. Reductions to a
		// scalar or to indices (ARRAY_REDUCE_METHODS) never carry.
		eachNode(sourceFile, (node) => {
			if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
				return;
			const bound = node.name.text;
			const init = unwrapValueNode(node.initializer);
			if (!ts.isCallExpression(init)) return;
			const callee = propertyName(init.expression);
			if (!callee || callee.computed) return;
			if (!arrayRooted(callee.object)) return;

			const callbackCarries = (callback) => {
				if (!callback) return true; // no inline callback to read — fail closed
				if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return true;
				const elementParam = callback.parameters[0];
				const paramName =
					elementParam && ts.isIdentifier(elementParam.name) ? elementParam.name.text : null;
				if (!paramName) return true;
				const returns = [];
				const body = callback.body;
				if (ts.isArrowFunction(callback) && body && !ts.isBlock(body)) {
					returns.push(body);
				} else if (body && ts.isBlock(body)) {
					eachNodeOwn(body, (n) => {
						if (ts.isReturnStatement(n)) returns.push(n.expression ?? null);
					});
				}
				if (returns.length === 0) return false; // returns nothing — undefined
				let carries = false;
				for (const returned of returns) {
					if (returned === null) continue; // bare return — undefined
					const expr = unwrapValueNode(returned);
					if (ts.isIdentifier(expr) && expr.text === paramName) {
						carries = true; // identity — the element itself
						continue;
					}
					if (
						ts.isStringLiteral(expr) ||
						ts.isNumericLiteral(expr) ||
						ts.isNoSubstitutionTemplateLiteral(expr) ||
						expr.kind === ts.SyntaxKind.TrueKeyword ||
						expr.kind === ts.SyntaxKind.FalseKeyword ||
						expr.kind === ts.SyntaxKind.NullKeyword ||
						expr.kind === ts.SyntaxKind.UndefinedKeyword ||
						ts.isObjectLiteralExpression(expr) ||
						ts.isArrayLiteralExpression(expr)
					)
						continue; // provably a fresh value
					carries = true; // a member read, a call, anything unproven — fail closed
				}
				return carries;
			};

			const method = callee.name;
			if (ARRAY_REDUCE_METHODS.has(method)) return;
			if (method === 'map' || method === 'flatMap' || method === 'filter') {
				if (!callbackCarries(init.arguments[0])) return;
				if (!arrayContainers.has(bound)) {
					arrayContainers.add(bound);
					arrayValueIndex.set(bound, 'any');
					changed = true;
				}
				return;
			}
			if (method === 'find' || method === 'findLast' || method === 'at' || method === 'reduce') {
				// The result can BE the element — a scalar binding of the reference.
				if (addValueName(bound)) changed = true;
				return;
			}
			// slice, concat, toSorted, toReversed, toSpliced, sort, reverse, with,
			// values, entries — and any method this reading does not name: the
			// result is treated as an array that carries the reference.
			if (!arrayContainers.has(bound)) {
				arrayContainers.add(bound);
				arrayValueIndex.set(bound, 'any');
				changed = true;
			}
		});

		// R7-3: GENERATORS that yield the reference — `function* stream() {
		// yield preview; }` makes `for (const p of stream())` a value binding.
		for (const [name, infos] of functions) {
			if (yieldCarrying.has(name)) continue;
			for (const { node } of infos) {
				const fnNode = node;
				if (!fnNode.asteriskToken) continue;
				let yields = false;
				eachNodeOwn(fnNode.body ?? fnNode, (n) => {
					if (yields) return;
					if (ts.isYieldExpression(n)) {
						if (n.asteriskToken && n.expression && arrayRooted(n.expression)) yields = true;
						else if (n.expression && holdsValue(n.expression)) yields = true;
					}
				});
				if (yields) {
					yieldCarrying.add(name);
					changed = true;
					break;
				}
			}
		}

		// R7-3: container CONSTRUCTORS seeded with the reference — `new Set(
		// [preview])`, `new Map([[k, preview]])` — carry it exactly like a
		// container that received it through `.add`/`.set`.
		eachNode(sourceFile, (node) => {
			if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
				return;
			const init = unwrapValueNode(node.initializer);
			if (
				!ts.isNewExpression(init) ||
				!ts.isIdentifier(init.expression) ||
				!['Set', 'Map', 'WeakSet', 'WeakMap'].includes(init.expression.text)
			)
				return;
			const seeded = (init.arguments ?? []).some((argument) => {
				if (holdsValue(argument)) return true;
				const inner = unwrapValueNode(argument);
				if (ts.isArrayLiteralExpression(inner))
					return inner.elements.some((element) => {
						if (holdsValue(element)) return true;
						const el = unwrapValueNode(element);
						return (
							ts.isArrayLiteralExpression(el) && el.elements.some((entry) => holdsValue(entry))
						);
					});
				return false;
			});
			if (seeded && !mapContainers.has(node.name.text)) {
				mapContainers.add(node.name.text);
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
						if (ts.isReturnStatement(n) && n.expression && holdsValue(n.expression)) returns = true;
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
		// R7-3: `paramNames === null` is an UNPROVEN constructor (a heritage
		// clause with no declared constructor); it derives no local names — the
		// call sites treat the entry itself as unprovable.
		for (const param of paramNames ?? []) {
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
		if (ts.isIdentifier(inner))
			return arrayContainers.has(inner.text) || mapContainers.has(inner.text);
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
			let access = propertyName(node.left);
			// R7-3: an element-access key bound to a constant string names the
			// property the literal spelling does — `const kk = 'html';
			// holder.body[kk] = …` is a `.html` write, not an unresolved key.
			if (access && access.computed && ts.isElementAccessExpression(node.left)) {
				const folded = foldLocalKey(node.left.argumentExpression);
				if (folded !== null) access = { name: folded, object: access.object, computed: false };
			}
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
								.slice(
									0,
									40
								)}… — a value bound to the preview reference can be transformed before the sink`
						);
				} else if (access.computed && holdsValue(receiver)) {
					// R7-3: a COMPUTED write on any read this reading binds to the
					// reference — `stash.body[key] = …`, `arr.map((p) => p)[0][k] = …`
					// — fails closed: the key no static read can fold could be 'html'.
					findings.push(
						`${file} writes through a computed key on a value bound to the preview reference — the key could be 'html' and lesser's bytes would be transformed before the sink`
					);
				}
			}
			return;
		}
		if (
			node.kind === ts.SyntaxKind.PrefixUnaryExpression ||
			node.kind === ts.SyntaxKind.PostfixUnaryExpression
		) {
			let access = propertyName(node.operand);
			if (access && access.computed && ts.isElementAccessExpression(node.operand)) {
				const folded = foldLocalKey(node.operand.argumentExpression);
				if (folded !== null) access = { name: folded, object: access.object, computed: false };
			}
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
				// R7-3: the mutation APIs are bound at the VALUE, not the
				// identifier — `Object.assign(stash.body, …)` reaches the
				// reference through a late-populated container read exactly as
				// `Object.assign(preview, …)` does.
				if (
					receiver &&
					holdsValue(receiver) &&
					((callee.object.text === 'Object' &&
						['assign', 'defineProperty', 'defineProperties'].includes(callee.name)) ||
						(callee.object.text === 'Reflect' && callee.name === 'set'))
				) {
					const inner = unwrapValueNode(receiver);
					const described = ts.isIdentifier(inner)
						? inner.text
						: 'a value bound to the preview reference';
					findings.push(
						`${file} mutates ${described} through ${callee.object.text}.${callee.name}(…) — lesser's preview value must remain verbatim`
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
					else if (infos.some((info) => info.paramNames === null))
						findings.push(
							`${file} passes the preview value to ${calleeExpr.text}(…) — its inherited constructor cannot be proven to leave the value untouched`
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
					.slice(
						0,
						60
					)}… — a route between loadDraftPreview and the sink cannot be statically proven direct`
			);
			return;
		}
		// R6-2: a `new` expression is a constructor hop — `class Mangler {
		// constructor(p) { p.html = … } }; new Mangler(preview)` writes the
		// value inside a constructor, and a class whose constructor this reading
		// cannot prove clean is the same unproven hop a call is.
		if (ts.isNewExpression(node)) {
			if (!node.arguments.some((argument) => holdsValue(argument))) return;
			const calleeExpr = unwrapValueNode(node.expression);
			if (ts.isIdentifier(calleeExpr)) {
				const infos = functions.get(calleeExpr.text);
				if (infos && infos.length) {
					if (mutatingFunctions.has(calleeExpr.text))
						findings.push(
							`${file} passes the preview value to new ${calleeExpr.text}(…) — its constructor writes the value, transforming lesser's bytes before the sink`
						);
					else if (infos.some((info) => info.paramNames === null))
						findings.push(
							`${file} passes the preview value to new ${calleeExpr.text}(…) — its inherited constructor cannot be proven to leave the value untouched`
						);
				} else {
					findings.push(
						`${file} passes the preview value to new ${calleeExpr.text}(…) — a constructor hop between loadDraftPreview and the sink cannot be statically proven direct`
					);
				}
				return;
			}
			findings.push(
				`${file} passes the preview value to ${node.expression
					.getText(sourceFile)
					.slice(
						0,
						60
					)}… — a route between loadDraftPreview and the sink cannot be statically proven direct`
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
		previewImports.length > 0 || invocations.length > 0 || dynamicSpecifiers.size > 0;

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

/* -------------------------------------------------------------------------
 * R6-1 — cross-file component/value flow (the second preview route).
 *
 * The per-file reading above is keyed on a file that ITSELF reaches PreviewBody
 * by import, invocation, or dynamic specifier. The round-6 plant proved that is
 * not the whole path: the canonical file can hand the PreviewBody COMPONENT and
 * the preview VALUE to a wrapper through props, and the wrapper can invoke the
 * component through `<svelte:component this={body} preview={value}/>` with no
 * PreviewBody import of its own — so `previewReach` stayed false, the
 * svelte:component rule never fired, and a second live route rendered lesser's
 * bytes (mutated first, in the plant's own `$effect`).
 *
 * This reading follows the flow across files. It is bounded to what the threat
 * is — the ONE canonical route — and fails closed on everything else:
 *
 *   - a `<svelte:component>` carrying a `preview` attribute (or a spread that
 *     could carry one) must resolve `this` to a component this reading can
 *     prove does not reach the preview route; a prop, an unbound name, a
 *     member expression, or a preview-reaching wrapper is a finding;
 *   - a static invocation of a known preview-reaching component must pass a
 *     value PROVABLY not the preview for every preview-flowing prop; a prop,
 *     a call, a member read, or an unresolvable spread fails closed;
 *   - the PreviewBody component itself may appear only in the canonical
 *     invocation; handing it to another component through a prop, or naming
 *     it in the canonical script outside the import, is a finding;
 *   - vendored and external components are benign only because none of them
 *     can reach an OWNED PreviewBody module; an owned wrapper is benign only
 *     when the fixed point proves it never forwards to the route.
 *
 * There is no token blacklist: every verdict is about the parsed shape of an
 * expression resolved through the owned module graph, and a file that reaches
 * PreviewBody only through a route this reading cannot prove direct is a
 * finding, never a clean scan.
 * ---------------------------------------------------------------------- */

const PREVIEW_BODY_MODULE = 'src/lib/review/PreviewBody.svelte';
const CANONICAL_PREVIEW_FILE = 'src/lib/routes/ReviewWorkspace.svelte';

/**
 * Resolve an import specifier to a repository-relative module path the way the
 * toolchain resolves it. `$lib/x` is the `src/lib/x` alias; `./x` and `../x`
 * resolve against the importing file's directory. A bare specifier is a
 * package, and a specifier this reading does not model returns null.
 */
function resolveOwnedSpecifier(specifier, fromFile) {
	if (specifier.startsWith('$lib/')) return `src/lib/${specifier.slice('$lib/'.length)}`;
	if (specifier === '$lib') return 'src/lib';
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		const parts = fromFile.split('/');
		const base = parts.slice(0, -1).join('/');
		const resolved = `${base}/${specifier}`.split('/').reduce((acc, part) => {
			if (part === '.' || part === '') return acc;
			if (part === '..') {
				acc.pop();
				return acc;
			}
			acc.push(part);
			return acc;
		}, []);
		return resolved.join('/');
	}
	return null;
}

/**
 * R6-1 + R7-1 — the cross-file preview route scan over OWNED Svelte modules.
 *
 * `files` is a Map of repository-relative path -> source for every owned
 * `.svelte` module (the audit walks OWNED_SOURCE_DIRS and hands the collection
 * here), so module resolution never leaves the owned tree. Returns findings
 * already prefixed with the file path.
 *
 * THE ROUND-7 WIDENING. The round-6 reading resolved a static invocation's
 * callee only when it was an OWNED Svelte module in `files`; a callee that was
 * a prop, an unbound name, a dotted member, or an owned barrel re-export was
 * skipped, and a markup spread was a boolean flag with no reading of the keys
 * it carries. Two plants lived in that gap: an owned wrapper invoking
 * `<Comp preview={shown}/>` with `Comp` supplied through props, fed from the
 * canonical file by `<PreviewSlot {...{ Comp: PreviewBody, value: preview }}
 * />`; and `<Mod.default preview={value}/>` with the namespace itself a prop.
 * Round-7 closes both:
 *
 *   - a static invocation whose callee is a prop, unbound, member, or an owned
 *     module this reading cannot resolve to a component fails closed whenever
 *     a preview-flowing value can reach it — a `preview` attribute or a
 *     spread — because the callee could BE PreviewBody;
 *   - markup spread expressions are READ, not merely counted: object literals,
 *     aliases bound to object literals or to local helper returns, shorthand,
 *     computed keys folded through constant strings, and nested spreads
 *     resolve into their keys, and a spread the reading cannot resolve fails
 *     closed;
 *   - dotted callee names resolve conservatively — a member of a prop, an
 *     unbound name, or an owned namespace is never a trusted owned component;
 *   - imports resolve through owned barrels by following `export … from`
 *     chains; a chain the reading cannot chase to an owned component is
 *     UNPROVEN rather than benign, while vendored and package modules stay
 *     benign because none of them can reach an owned PreviewBody module;
 *   - legacy `export let` props, `$props()` rest/nested/bindable forms, and
 *     markup `{@const}` component aliases feed the same resolution.
 */
export function previewForwardingFindings(files, options = {}) {
	const findings = [];
	// `modules` is the FULL owned executable source map (path -> source) when
	// the audit supplies it; barrel tracing reads non-Svelte modules through
	// it. `vendoredRoots`/`vendoredFiles` name the CLI-managed tree, whose
	// components cannot reach an owned PreviewBody and therefore stay benign.
	const modules = options.modules ?? files;
	const vendoredRoots = options.vendoredRoots ?? [];
	const vendoredFiles = new Set(options.vendoredFiles ?? []);
	// R8-1: the build's `resolve.alias` table, parsed from the governed root
	// modules by the audit and handed in normalized to repository-relative
	// replacement paths (a null replacement is an entry the scan matched but
	// cannot follow — outside the repository or unreadable). `aliasUnresolved`
	// says at least one alias ENTRY could not be read at all, in which case any
	// bare specifier could be its target. `packageInstalled` answers whether a
	// bare specifier an alias does not claim is answered for by an installed
	// package — one that is not is a route no static read can prove.
	const resolveAliases = options.resolveAliases ?? [];
	const aliasUnresolved = options.aliasUnresolved === true;
	const packageInstalled = options.packageInstalled ?? (() => true);
	const isVendoredPath = (path) =>
		vendoredFiles.has(path) ||
		vendoredRoots.some((root) => path === root || path.startsWith(`${root}/`));
	const moduleExists = (path) => modules.has(path);

	// --- per-file extraction --------------------------------------------------
	const flows = new Map(); // path -> facts
	for (const [path, source] of files) {
		let ast;
		let sourceFile;
		try {
			ast = parseSvelte(path, source);
			const scriptText = svelteScriptContents(path, source)
				.map(({ text }) => text)
				.join('\n');
			sourceFile = parseTypeScript(scriptText, { file: `${path} (scripts)` });
		} catch (error) {
			findings.push(
				`${path} could not be read for the cross-file preview route scan: ${error.message}`
			);
			continue;
		}

		const imports = new Map(); // localName -> { specifier, importedName }
		const propBindings = new Map(); // localName -> propName
		const wholeProps = new Set(); // names bound to the whole $props() object (or a rest/nested slice of it)
		const componentAliases = new Map(); // localName -> aliased imported name
		const constantStrings = new Map(); // localName -> folded constant string
		const scriptInitializers = new Map(); // localName -> TS initializer node
		const scriptFnNodes = new Map(); // localName -> TS function node
		const markupConstObjects = new Map(); // name -> estree expression from {@const}
		eachNode(sourceFile, (node) => {
			if (
				ts.isImportDeclaration(node) &&
				!node.importClause?.isTypeOnly &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const clause = node.importClause;
				if (clause?.name)
					imports.set(clause.name.text, {
						specifier: node.moduleSpecifier.text,
						importedName: 'default',
					});
				if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const element of clause.namedBindings.elements)
						if (!element.isTypeOnly)
							imports.set(element.name.text, {
								specifier: node.moduleSpecifier.text,
								importedName: element.propertyName?.text ?? element.name.text,
							});
				}
				if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
					imports.set(clause.namedBindings.name.text, {
						specifier: node.moduleSpecifier.text,
						importedName: '*',
					});
			}
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
				if (ts.isIdentifier(node.initializer))
					componentAliases.set(node.name.text, node.initializer.text);
				const literal = foldPropertyKey(node.initializer);
				if (literal !== null) constantStrings.set(node.name.text, literal);
				if (!scriptInitializers.has(node.name.text))
					scriptInitializers.set(node.name.text, node.initializer);
				if (
					(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
					!scriptFnNodes.has(node.name.text)
				)
					scriptFnNodes.set(node.name.text, node.initializer);
			}
			if (ts.isFunctionDeclaration(node) && node.name && !scriptFnNodes.has(node.name.text))
				scriptFnNodes.set(node.name.text, node);
			// R7-1: legacy `export let` props — the pre-runes spelling declares a
			// component prop exactly as a `$props()` destructure does.
			if (
				ts.isVariableStatement(node) &&
				(node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
			) {
				for (const declaration of node.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name))
						propBindings.set(declaration.name.text, declaration.name.text);
					else for (const leaf of bindingNames(declaration.name)) wholeProps.add(leaf);
				}
			}
			if (
				ts.isVariableStatement(node) &&
				node.declarationList.declarations[0]?.initializer !== undefined &&
				ts.isCallExpression(node.declarationList.declarations[0].initializer) &&
				ts.isIdentifier(node.declarationList.declarations[0].initializer.expression) &&
				node.declarationList.declarations[0].initializer.expression.text === '$props'
			) {
				for (const declaration of node.declarationList.declarations) {
					if (ts.isObjectBindingPattern(declaration.name)) {
						for (const element of declaration.name.elements) {
							if (!ts.isBindingElement(element)) continue;
							// R7-1: a `$props()` REST element carries every prop —
							// `{...spread}` from it can include `preview` — so its
							// name joins the whole-prop set.
							if (element.dotDotDotToken) {
								for (const leaf of bindingNames(element.name)) wholeProps.add(leaf);
								continue;
							}
							if (ts.isIdentifier(element.name)) {
								const propName =
									element.propertyName && ts.isIdentifier(element.propertyName)
										? element.propertyName.text
										: element.name.text;
								propBindings.set(element.name.text, propName);
							} else {
								// R7-1: a NESTED pattern destructures a prop's own
								// properties — which property of the incoming object
								// each leaf holds cannot be proven from the pattern,
								// so the leaves join the whole-prop set.
								for (const leaf of bindingNames(element.name)) wholeProps.add(leaf);
							}
						}
					} else if (ts.isIdentifier(declaration.name)) {
						wholeProps.add(declaration.name.text);
					}
				}
			}
		});

		const svelteComponents = [];
		const invocations = [];
		const visitMarkup = (node) => {
			if (!node || typeof node !== 'object') return;
			// R7-1: markup `{@const}` declarations bind component aliases and
			// object constants the spread reading must see — `{@const Body = X}`
			// renames a component exactly as a script `const` would.
			if (node.type === 'ConstTag' && node.expression?.type === 'AssignmentExpression') {
				const assignment = node.expression;
				if (assignment.left?.type === 'Identifier') {
					markupConstObjects.set(assignment.left.name, assignment.right ?? null);
					if (assignment.right?.type === 'Identifier')
						componentAliases.set(assignment.left.name, assignment.right.name);
				}
			}
			if (node.type === 'SvelteComponent') {
				const attrs = node.attributes ?? [];
				const preview = attrs.find(
					(entry) =>
						(entry.type === 'Attribute' || entry.type === 'BindDirective') &&
						entry.name === 'preview'
				);
				svelteComponents.push({
					thisText: componentThisText(node.expression),
					thisIsIdentifier: node.expression?.type === 'Identifier',
					previewValue: preview
						? preview.type === 'BindDirective'
							? expressionShape(preview.expression)
							: attributeValueShape(preview)
						: null,
					hasSpread: attrs.some((entry) => entry.type === 'SpreadAttribute'),
				});
			}
			if (node.type === 'Component') {
				const attrs = [];
				const spreads = [];
				for (const attribute of node.attributes ?? []) {
					if (attribute.type === 'Attribute')
						attrs.push({ name: attribute.name, value: attributeValueShape(attribute) });
					else if (attribute.type === 'BindDirective' && typeof attribute.name === 'string')
						// R7-1: `bind:preview={value}` forwards the value exactly as
						// `preview={value}` does — and bidirectionally, so a bind is
						// if anything a stronger route.
						attrs.push({ name: attribute.name, value: expressionShape(attribute.expression) });
					else if (attribute.type === 'SpreadAttribute') spreads.push(attribute.expression ?? null);
				}
				invocations.push({ name: node.name, attrs, spreads, spreadAnalysis: null });
			}
			for (const key of Object.keys(node)) {
				if (key === 'parent') continue;
				visitMarkup(node[key]);
			}
		};
		visitMarkup(ast.fragment);

		flows.set(path, {
			ast,
			sourceFile,
			imports,
			propBindings,
			wholeProps,
			componentAliases,
			constantStrings,
			scriptInitializers,
			scriptFnNodes,
			markupConstObjects,
			svelteComponents,
			invocations,
		});
	}

	/**
	 * The shape of an attribute value expression: `{kind: 'identifier', name}`
	 * when the value IS one local name, `{kind: 'literal'}` when it is provably
	 * a fresh literal (a string, number, null, an object or array literal), and
	 * `{kind: 'other'}` for a call, a member read, a conditional — a value this
	 * reading cannot prove anything about. Null when there is no expression.
	 */
	function expressionShape(expression) {
		if (!expression || typeof expression !== 'object') return null;
		if (expression.type === 'Identifier' && typeof expression.name === 'string')
			return { kind: 'identifier', name: expression.name };
		if (expression.type === 'Literal') return { kind: 'literal' };
		if (expression.type === 'ObjectExpression' || expression.type === 'ArrayExpression')
			return { kind: 'literal' };
		return { kind: 'other' };
	}

	function attributeValueShape(attribute) {
		const values = Array.isArray(attribute.value)
			? attribute.value
			: [attribute.value].filter(Boolean);
		const tag = values.find((value) => value?.type === 'ExpressionTag');
		if (!tag?.expression) return null;
		return expressionShape(tag.expression);
	}

	function componentThisText(expression) {
		if (!expression) return null;
		if (expression.type === 'Identifier' && typeof expression.name === 'string')
			return expression.name;
		return null;
	}

	// --- R7-1 spread / object construction reading ----------------------------
	/**
	 * The value shape a TS expression offers, unwrapped of parentheses,
	 * non-null assertions and casts.
	 */
	const shapeOfTs = (node) => {
		const inner = unwrapValueNode(node);
		if (!inner) return { kind: 'other' };
		if (ts.isIdentifier(inner)) return { kind: 'identifier', name: inner.text };
		if (
			ts.isStringLiteral(inner) ||
			ts.isNumericLiteral(inner) ||
			ts.isNoSubstitutionTemplateLiteral(inner) ||
			inner.kind === ts.SyntaxKind.TrueKeyword ||
			inner.kind === ts.SyntaxKind.FalseKeyword ||
			inner.kind === ts.SyntaxKind.NullKeyword ||
			inner.kind === ts.SyntaxKind.UndefinedKeyword ||
			ts.isObjectLiteralExpression(inner) ||
			ts.isArrayLiteralExpression(inner)
		)
			return { kind: 'literal' };
		return { kind: 'other' };
	};
	const shapeOfEstree = (expr) => {
		if (!expr || typeof expr !== 'object') return { kind: 'other' };
		if (expr.type === 'Identifier' && typeof expr.name === 'string')
			return { kind: 'identifier', name: expr.name };
		if (
			expr.type === 'Literal' ||
			expr.type === 'ObjectExpression' ||
			expr.type === 'ArrayExpression' ||
			expr.type === 'TemplateLiteral'
		)
			return { kind: 'literal' };
		return { kind: 'other' };
	};

	/**
	 * The folded keys and value shapes of an object construction, read through
	 * aliases, helper returns, shorthand, computed keys folded through constant
	 * strings, and nested spreads. Returns `[{ name, value }]` or null when any
	 * part cannot be resolved — an unresolved spread fails closed at the call
	 * site. `seen` guards alias cycles.
	 */
	/**
	 * The object attrs a LOCAL function's returns offer — every return must
	 * resolve to an object construction, and the attrs merge; a function with
	 * no readable return is unresolvable.
	 */
	const tsFunctionReturnAttrs = (fnNode, flow, seen) => {
		const attrs = [];
		let resolved = false;
		const body = fnNode.body;
		if (ts.isArrowFunction(fnNode) && body && !ts.isBlock(body)) {
			return analyzeTsObject(body, flow, seen);
		}
		const visitReturns = (n, top = true) => {
			if (!n || typeof n !== 'object') return;
			if (
				!top &&
				(ts.isFunctionDeclaration(n) ||
					ts.isArrowFunction(n) ||
					ts.isFunctionExpression(n) ||
					ts.isMethodDeclaration(n))
			)
				return;
			if (ts.isReturnStatement(n)) {
				if (!n.expression) return;
				const inner = analyzeTsObject(n.expression, flow, seen);
				if (inner === null) return;
				resolved = true;
				attrs.push(...inner);
				return;
			}
			ts.forEachChild(n, (child) => visitReturns(child, false));
		};
		if (body) visitReturns(body);
		return resolved ? attrs : null;
	};

	const analyzeTsObject = (node, flow, seen) => {
		if (!node) return null;
		if (ts.isParenthesizedExpression(node)) return analyzeTsObject(node.expression, flow, seen);
		if (ts.isIdentifier(node)) {
			if (seen.has(node.text)) return null;
			seen.add(node.text);
			const initializer = flow.scriptInitializers.get(node.text);
			if (initializer) return analyzeTsObject(initializer, flow, seen);
			return null;
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const fnNode = flow.scriptFnNodes.get(node.expression.text);
			if (!fnNode) return null;
			return tsFunctionReturnAttrs(fnNode, flow, seen);
		}
		if (!ts.isObjectLiteralExpression(node)) return null;
		const attrs = [];
		for (const property of node.properties) {
			if (ts.isSpreadAssignment(property)) {
				const inner = analyzeTsObject(property.expression, flow, seen);
				if (inner === null) return null;
				attrs.push(...inner);
				continue;
			}
			if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
				const key = ts.isIdentifier(property.name)
					? property.name.text
					: ts.isStringLiteral(property.name)
						? property.name.text
						: ts.isComputedPropertyName(property.name)
							? (foldPropertyKey(property.name.expression) ??
								(ts.isIdentifier(property.name.expression)
									? (flow.constantStrings.get(property.name.expression.text) ?? null)
									: null))
							: null;
				if (key === null) return null;
				attrs.push({ name: key, value: { kind: 'other' } });
				continue;
			}
			let key = null;
			let value = null;
			if (ts.isPropertyAssignment(property)) {
				key = ts.isComputedPropertyName(property.name)
					? (foldPropertyKey(property.name.expression) ??
						(ts.isIdentifier(property.name.expression)
							? (flow.constantStrings.get(property.name.expression.text) ?? null)
							: null))
					: ts.isIdentifier(property.name)
						? property.name.text
						: ts.isStringLiteral(property.name)
							? property.name.text
							: null;
				value = shapeOfTs(property.initializer);
			} else if (ts.isShorthandPropertyAssignment(property)) {
				key = property.name.text;
				value = { kind: 'identifier', name: property.name.text };
			} else {
				return null;
			}
			if (key === null) return null;
			attrs.push({ name: key, value });
		}
		return attrs;
	};

	const foldEstreeKey = (expr, flow) => {
		if (!expr || typeof expr !== 'object') return null;
		if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
		if (expr.type === 'TemplateLiteral' && (expr.expressions ?? []).length === 0)
			return expr.quasis?.[0]?.value?.cooked ?? null;
		if (expr.type === 'Identifier' && typeof expr.name === 'string')
			return flow.constantStrings.get(expr.name) ?? null;
		return null;
	};

	const analyzeEstreeObject = (expr, flow, seen) => {
		if (!expr || typeof expr !== 'object') return null;
		if (expr.type === 'Identifier' && typeof expr.name === 'string') {
			if (seen.has(expr.name)) return null;
			seen.add(expr.name);
			const markupInit = flow.markupConstObjects.get(expr.name);
			if (markupInit) return analyzeEstreeObject(markupInit, flow, seen);
			const scriptInit = flow.scriptInitializers.get(expr.name);
			if (scriptInit) return analyzeTsObject(scriptInit, flow, seen);
			return null;
		}
		if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier') {
			const fnNode = flow.scriptFnNodes.get(expr.callee.name);
			if (!fnNode) return null;
			return tsFunctionReturnAttrs(fnNode, flow, seen);
		}
		if (expr.type !== 'ObjectExpression') return null;
		const attrs = [];
		for (const property of expr.properties ?? []) {
			if (property.type === 'SpreadElement') {
				const inner = analyzeEstreeObject(property.argument, flow, seen);
				if (inner === null) return null;
				attrs.push(...inner);
				continue;
			}
			if (property.type !== 'Property') return null;
			let key = null;
			if (property.computed) key = foldEstreeKey(property.key, flow);
			else if (property.key?.type === 'Identifier') key = property.key.name;
			else if (property.key?.type === 'Literal' && typeof property.key.value === 'string')
				key = property.key.value;
			if (key === null) return null;
			attrs.push({ name: key, value: shapeOfEstree(property.value) });
		}
		return attrs;
	};

	/**
	 * The resolved spread attributes of an invocation: `{ attrs, complete }`.
	 * Every spread that resolves contributes its folded keys as synthetic
	 * attributes; any spread the reading cannot resolve drops `complete` and
	 * fails closed at the verdict sites.
	 */
	const invocationSpreadAnalysis = (invocation, flow) => {
		if (invocation.spreadAnalysis) return invocation.spreadAnalysis;
		const attrs = [];
		let complete = true;
		for (const expr of invocation.spreads) {
			const resolved = expr ? analyzeEstreeObject(expr, flow, new Set()) : null;
			if (resolved === null) {
				complete = false;
				continue;
			}
			attrs.push(...resolved);
		}
		invocation.spreadAnalysis = { attrs, complete };
		return invocation.spreadAnalysis;
	};

	// --- module resolution ----------------------------------------------------
	const SCRIPT_MODULE_EXTENSIONS = [
		'.svelte',
		'.ts',
		'.mts',
		'.cts',
		'.tsx',
		'.js',
		'.mjs',
		'.cjs',
		'.jsx',
	];
	const findModuleFile = (base) => {
		for (const extension of SCRIPT_MODULE_EXTENSIONS) {
			if (moduleExists(base + extension)) return base + extension;
		}
		for (const extension of SCRIPT_MODULE_EXTENSIONS) {
			if (moduleExists(`${base}/index${extension}`)) return `${base}/index${extension}`;
		}
		return null;
	};

	/**
	 * R7-1: chase a re-export chain through OWNED non-Svelte modules — a barrel
	 * `export { default as Body } from './PreviewBody.svelte'` resolves to the
	 * component it names; a chain the reading cannot chase all the way to an
	 * owned Svelte module returns null, and the caller treats that as UNPROVEN,
	 * never benign.
	 */
	const traceBarrel = (base, importedName, visited, depth) => {
		if (depth > 8) return null;
		const file = findModuleFile(base);
		if (!file) return null;
		if (file.endsWith('.svelte')) return files.has(file) ? file : null;
		if (visited.has(file)) return null;
		visited.add(file);
		const source = modules.get(file);
		if (source === undefined) return null;
		let barrelSourceFile;
		try {
			barrelSourceFile = parseTypeScript(source, { file, jsx: /\.(tsx|jsx)$/.test(file) });
		} catch {
			return null;
		}
		for (const statement of barrelSourceFile.statements) {
			if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
			if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const nextBase = resolveOwnedSpecifier(statement.moduleSpecifier.text, file);
			if (nextBase === null) continue;
			if (statement.exportClause === undefined) {
				// `export * from '…'` — the name could come through here; an
				// owned star re-export is chased like any other route.
				const traced = traceBarrel(nextBase, importedName, visited, depth + 1);
				if (traced) return traced;
				continue;
			}
			if (!ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				if (element.name.text !== importedName) continue;
				const localName = element.propertyName?.text ?? element.name.text;
				const traced = traceBarrel(nextBase, localName, visited, depth + 1);
				if (traced) return traced;
			}
		}
		return null;
	};

	/**
	 * R8-1: classify a BARE specifier — one `$lib`/relative resolution declined.
	 * The build's `resolve.alias` table is read FIRST, exactly as the bundler
	 * reads it: a matched alias routes the specifier to its replacement, judged
	 * like any spelled path (owned, vendored, or unproven when it escapes the
	 * classified roots or the scan cannot follow it). A specifier no alias
	 * claims is a package ONLY when an installed package answers for it and no
	 * unreadable alias entry could capture the name; otherwise the route cannot
	 * be statically proven and fails closed.
	 */
	const classifyBareSpecifier = (specifier, importedName) => {
		const aliased = resolveAliasedSpecifier(specifier, resolveAliases);
		if (aliased !== null) {
			if (aliased.kind === 'unproven') return { kind: 'unproven' };
			const path = aliased.path;
			const withExt = files.has(path)
				? path
				: files.has(`${path}.svelte`)
					? `${path}.svelte`
					: null;
			if (withExt) return { kind: 'owned', path: withExt };
			if (isVendoredPath(path)) return { kind: 'external' };
			if (path.startsWith('src/') || path.startsWith('scripts/')) {
				const traced = traceBarrel(path, importedName, new Set(), 0);
				if (traced) return { kind: 'owned', path: traced };
			}
			// The alias routes OUTSIDE the classified roots — the universe
			// check's territory. It can never be a trusted owned component.
			return { kind: 'unproven' };
		}
		if (aliasUnresolved) return { kind: 'unproven' };
		return packageInstalled(specifier) ? { kind: 'external' } : { kind: 'unproven' };
	};

	const resolveSimpleName = (name, flow) => {
		const entry = flow.imports.get(name);
		if (entry !== undefined) {
			// A NAMESPACE import of an owned module could hold any re-exported
			// component; its members are judged at the member site as unproven.
			if (entry.importedName === '*') {
				const resolved = resolveOwnedSpecifier(entry.specifier, flow.fromPath);
				if (resolved === null) return classifyBareSpecifier(entry.specifier, entry.importedName);
				if (isVendoredPath(resolved)) return { kind: 'external' };
				return { kind: 'owned-namespace', specifier: entry.specifier };
			}
			const resolved = resolveOwnedSpecifier(entry.specifier, flow.fromPath);
			if (resolved === null) return classifyBareSpecifier(entry.specifier, entry.importedName);
			const withExt = files.has(resolved)
				? resolved
				: files.has(`${resolved}.svelte`)
					? `${resolved}.svelte`
					: null;
			if (withExt) return { kind: 'owned', path: withExt };
			if (isVendoredPath(resolved)) return { kind: 'external' };
			if (resolved.startsWith('src/') || resolved.startsWith('scripts/')) {
				// R7-1: an OWNED module that is not itself a known Svelte
				// component — a barrel or re-export. Chase the export chain for
				// the imported name; anything less than an owned component is
				// UNPROVEN rather than benign.
				const traced = traceBarrel(resolved, entry.importedName, new Set(), 0);
				if (traced) return { kind: 'owned', path: traced };
				return { kind: 'unproven' };
			}
			// R7-1: a relative import that ESCAPES the classified roots names an
			// executable module outside `src/` and `scripts/` — the round-7
			// universe's territory. It can never be a trusted owned component,
			// whatever it is; the component scan fails closed on it exactly as it
			// does on a prop, and the universe check names the file itself.
			return { kind: 'unproven' };
		}
		const alias = flow.componentAliases.get(name);
		if (alias !== undefined && alias !== name) return resolveLocalName(alias, flow);
		if (flow.propBindings.has(name)) return { kind: 'prop', propName: flow.propBindings.get(name) };
		if (flow.wholeProps.has(name)) return { kind: 'prop', propName: '*' };
		return { kind: 'unbound' };
	};
	const resolveLocalName = (name, flow) => {
		// R7-1: a DOTTED callee — `<Mod.default …>` — is a member expression.
		// Its base decides the verdict: a member of a package or vendored
		// namespace cannot reach an owned PreviewBody, but a member of a prop,
		// an unbound name, or an owned namespace is never a trusted owned
		// component — prop-supplied namespace members are whatever the parent
		// sent.
		const dot = name.indexOf('.');
		if (dot > 0) {
			const base = name.slice(0, dot);
			const baseResolved = resolveSimpleName(base, flow);
			if (baseResolved.kind === 'external') return { kind: 'external' };
			return { kind: 'member' };
		}
		return resolveSimpleName(name, flow);
	};
	for (const [path, flow] of flows) flow.fromPath = path;

	const UNPROVEN_KINDS = new Set(['prop', 'unbound', 'member', 'unproven']);

	// --- fixed point: preview reach and forwarding props ----------------------
	const reachesPreview = new Map(); // path -> boolean
	const forwardingProps = new Map(); // path -> Set<propName | '*'>
	const isPreviewBody = (path) => path === PREVIEW_BODY_MODULE;
	const isCanonical = (path) => path === CANONICAL_PREVIEW_FILE;

	let grew = true;
	while (grew) {
		grew = false;
		for (const [path, flow] of flows) {
			const forward = forwardingProps.get(path) ?? new Set();
			const markReach = () => {
				if (!reachesPreview.get(path)) {
					reachesPreview.set(path, true);
					grew = true;
				}
			};
			const addForward = (prop) => {
				if (!forward.has(prop)) {
					forward.add(prop);
					forwardingProps.set(path, forward);
					grew = true;
				}
			};

			// A static PreviewBody invocation (beyond the canonical one) is a
			// route; the preview attr value flowing from a prop makes the prop a
			// forwarder for the parent chain.
			for (const invocation of flow.invocations) {
				const callee = resolveLocalName(invocation.name, flow);
				const analysis = invocationSpreadAnalysis(invocation, flow);
				const allAttrs = [...invocation.attrs, ...analysis.attrs];
				const spreadUnresolved = invocation.spreads.length > 0 && !analysis.complete;

				if (callee.kind === 'owned' && isPreviewBody(callee.path)) {
					if (!isCanonical(path)) markReach();
					const preview = allAttrs.find((attr) => attr.name === 'preview');
					if (preview?.value?.kind === 'identifier') {
						const bound = flow.propBindings.get(preview.value.name);
						if (bound !== undefined) addForward(bound);
						else if (flow.wholeProps.has(preview.value.name)) addForward('*');
					} else if (preview?.value?.kind === 'other' || spreadUnresolved) {
						addForward('*');
					}
					continue;
				}
				// R7-1: a static invocation whose callee is a PROP, an unbound
				// name, a member expression, or an owned module this reading
				// cannot resolve to a component — the callee could BE PreviewBody,
				// so any preview-flowing value reaching it makes the position a
				// potential route: a `preview` attribute, or a spread that could
				// carry one.
				if (UNPROVEN_KINDS.has(callee.kind)) {
					if (spreadUnresolved) {
						markReach();
						addForward('*');
					}
					for (const attr of allAttrs) {
						if (attr.name !== 'preview') continue;
						if (attr.value?.kind === 'identifier') {
							const bound = flow.propBindings.get(attr.value.name);
							if (bound !== undefined) {
								addForward(bound);
								markReach();
							} else if (flow.wholeProps.has(attr.value.name)) {
								addForward('*');
								markReach();
							} else {
								markReach(); // a local this file does not receive — unprovable
							}
						} else if (attr.value?.kind === 'literal') {
							// provably not the preview — the route is fed nothing
						} else {
							markReach();
							addForward('*');
						}
					}
					continue;
				}
				if (callee.kind !== 'owned' || isPreviewBody(callee.path)) continue;
				// The canonical file hosts the ONE allowed preview route by design
				// and receives the value from loadDraftPreview, never from its own
				// props — so its internal reach is not a reason to flag a file that
				// happens to invoke it with page/data. Only the canonical file's
				// OWN forwarding of the value (covered by the findings below) is a
				// finding.
				if (isCanonical(callee.path)) continue;
				const calleeReach = reachesPreview.get(callee.path) ?? false;
				const calleeForward = forwardingProps.get(callee.path);
				if (!calleeReach && !(calleeForward && calleeForward.size > 0)) continue;
				if (spreadUnresolved) {
					markReach();
					addForward('*');
					continue;
				}
				for (const attr of allAttrs) {
					const flowsPreview =
						(calleeForward && (calleeForward.has(attr.name) || calleeForward.has('*'))) ||
						// R7-1: a callee that REACHES the route but whose feeding
						// props this reading cannot name is fed through ANY prop
						// that is not provably a fresh literal.
						(calleeReach && attr.value?.kind !== 'literal');
					if (!flowsPreview) continue;
					if (attr.value?.kind === 'identifier') {
						const bound = flow.propBindings.get(attr.value.name);
						if (bound !== undefined) addForward(bound);
						else if (flow.wholeProps.has(attr.value.name)) addForward('*');
						else markReach(); // a local name this file does not receive — unprovable
					} else if (attr.value?.kind === 'literal') {
						// provably not the preview — the route is fed nothing; the
						// callee's own reach is its own finding.
					} else {
						// null, a call, a member read — unprovable, fail closed
						markReach();
						addForward('*');
					}
				}
			}

			// A svelte:component with a preview attribute or a spread must
			// resolve `this` to a provably benign component. The canonical file's
			// own svelte:component is already a finding via the per-file rule (its
			// previewReach is true by the canonical invocation), so its reach is
			// not propagated to its invokers.
			if (isCanonical(path)) continue;
			for (const component of flow.svelteComponents) {
				if (!component.hasSpread && component.previewValue === null) continue;
				if (!component.thisIsIdentifier || component.thisText === null) {
					markReach();
					addForward('*');
					continue;
				}
				const resolved = resolveLocalName(component.thisText, flow);
				if (resolved.kind === 'owned' && isPreviewBody(resolved.path)) {
					markReach();
					continue;
				}
				if (resolved.kind === 'owned') {
					if (reachesPreview.get(resolved.path)) markReach();
					continue;
				}
				if (resolved.kind === 'external') continue; // cannot reach an owned PreviewBody
				// a prop, an unbound name, a member, an owned namespace or an
				// unproven barrel — the component could be PreviewBody or any
				// wrapper: fail closed
				markReach();
				addForward('*');
			}
		}
	}

	// --- findings -------------------------------------------------------------
	const describedCallee = (callee, invocation) => {
		if (callee.kind === 'prop') return `the prop-supplied component \`${invocation.name}\``;
		if (callee.kind === 'member') return `the member component \`${invocation.name}\``;
		if (callee.kind === 'unproven')
			return `\`${invocation.name}\`, an owned module this reading cannot resolve to a component`;
		return `the unbound component \`${invocation.name}\``;
	};
	for (const [path, flow] of flows) {
		const forward = forwardingProps.get(path) ?? new Set();

		// 1. Unresolved or preview-reaching <svelte:component> routes.
		for (const component of flow.svelteComponents) {
			if (!component.hasSpread && component.previewValue === null) continue;
			if (!component.thisIsIdentifier || component.thisText === null) {
				findings.push(
					`${path} invokes a component through <svelte:component> with a preview attribute (or spread) — the dynamic route cannot be statically proven to be the one canonical PreviewBody invocation`
				);
				continue;
			}
			const resolved = resolveLocalName(component.thisText, flow);
			if (resolved.kind === 'owned') {
				if (isPreviewBody(resolved.path)) {
					findings.push(
						`${path} dynamically invokes PreviewBody through <svelte:component> — a dynamic component route cannot be statically proven direct`
					);
				} else if (reachesPreview.get(resolved.path)) {
					findings.push(
						`${path} invokes ${resolved.path} through <svelte:component> with a preview attribute — a second preview route through a known wrapper cannot be statically proven to be the canonical invocation`
					);
				}
				continue;
			}
			if (resolved.kind === 'external') continue;
			findings.push(
				`${path} invokes a component through <svelte:component this={${component.thisText}}> with a preview attribute — the dynamic route cannot be statically proven to be the one canonical PreviewBody invocation`
			);
		}

		// 2. Static invocations of preview-reaching components must pass provably
		// non-preview values for every preview-flowing prop — and R7-1 extends
		// the rule to invocations whose callee is a prop, an unbound name, a
		// member expression, or an unresolvable owned module: those positions
		// fail closed on a `preview` attribute or an unreadable spread, because
		// the callee itself could be the PreviewBody route.
		for (const invocation of flow.invocations) {
			const callee = resolveLocalName(invocation.name, flow);
			const analysis = invocationSpreadAnalysis(invocation, flow);
			const allAttrs = [...invocation.attrs, ...analysis.attrs];
			const spreadUnresolved = invocation.spreads.length > 0 && !analysis.complete;

			if (UNPROVEN_KINDS.has(callee.kind)) {
				if (spreadUnresolved) {
					findings.push(
						`${path} spreads a value this reading cannot resolve onto ${describedCallee(callee, invocation)} — the spread could carry the preview value or the PreviewBody component into a route that cannot be statically proven to be the canonical invocation`
					);
				}
				for (const attr of allAttrs) {
					if (attr.name !== 'preview') continue;
					if (attr.value?.kind === 'literal') continue;
					const described =
						attr.value?.kind === 'identifier'
							? `\`${attr.value.name}\``
							: attr.value === null
								? 'a value'
								: 'an unreadable value';
					findings.push(
						`${path} passes ${described} through the preview prop of ${describedCallee(callee, invocation)} — a static invocation of a component this reading cannot resolve could be the PreviewBody route itself`
					);
				}
				continue;
			}
			if (callee.kind !== 'owned' || isPreviewBody(callee.path) || isCanonical(callee.path))
				continue;
			const calleeReach = reachesPreview.get(callee.path) ?? false;
			const calleeForward = forwardingProps.get(callee.path);
			if (!calleeReach && !(calleeForward && calleeForward.size > 0)) continue;
			if (spreadUnresolved) {
				findings.push(
					`${path} spreads attributes onto ${invocation.name} (${callee.path}), which forwards to a preview route — the spread could carry the preview value or the PreviewBody component`
				);
				continue;
			}
			for (const attr of allAttrs) {
				const flowsPreview =
					(calleeForward && (calleeForward.has(attr.name) || calleeForward.has('*'))) ||
					(calleeReach && attr.value?.kind !== 'literal');
				if (!flowsPreview) continue;
				if (attr.value?.kind === 'literal') continue; // provably not the preview
				const described =
					attr.value?.kind === 'identifier'
						? `\`${attr.value.name}\``
						: attr.value === null
							? 'a value'
							: 'an unreadable value';
				findings.push(
					`${path} passes ${described} through the ${attr.name} prop of ${invocation.name} (${callee.path}), which forwards to a preview route — a second route cannot be statically proven to be the canonical PreviewBody invocation`
				);
			}
		}

		// 3. The PreviewBody component may appear only in the canonical
		// invocation. Handing it to another component through a prop, or naming
		// it in the canonical script OR MARKUP outside the import, is a finding.
		if (isCanonical(path)) {
			eachNode(flow.sourceFile, (node) => {
				if (ts.isIdentifier(node) && node.text === 'PreviewBody') {
					const parent = node.parent;
					if (parent && ts.isImportClause(parent) && parent.name === node) return;
					findings.push(
						`${path} names the PreviewBody component outside the canonical invocation — the display route must stay the single direct <PreviewBody preview={preview}/>`
					);
				}
			});
			// R7-1: markup expressions are script's blind spot — a spread object
			// carrying `Comp: PreviewBody` lives in the template, so the template
			// gets the same name scan the script gets.
			const visitMarkupExpressions = (node) => {
				if (!node || typeof node !== 'object') return;
				if (node.type === 'Identifier' && node.name === 'PreviewBody') {
					findings.push(
						`${path} names the PreviewBody component in its markup outside the canonical invocation — the display route must stay the single direct <PreviewBody preview={preview}/>`
					);
				}
				for (const key of Object.keys(node)) {
					if (key === 'parent') continue;
					const child = node[key];
					if (Array.isArray(child)) {
						for (const entry of child) visitMarkupExpressions(entry);
					} else {
						visitMarkupExpressions(child);
					}
				}
			};
			visitMarkupExpressions(flow.ast.fragment);
			for (const invocation of flow.invocations) {
				if (invocation.name === 'PreviewBody') continue;
				const analysis = invocationSpreadAnalysis(invocation, flow);
				const allAttrs = [...invocation.attrs, ...analysis.attrs];
				for (const attr of allAttrs) {
					const isComponentRef =
						attr.value?.kind === 'identifier' &&
						(attr.value.name === 'PreviewBody' ||
							flow.componentAliases.get(attr.value.name) === 'PreviewBody');
					if (isComponentRef)
						findings.push(
							`${path} forwards the PreviewBody component through the ${attr.name} prop of ${invocation.name} — the canonical display route must stay direct`
						);
				}
			}
		}
	}

	return findings;
}

/* -------------------------------------------------------------------------
 * R8-1 — the build's `resolve.alias` table, read from the governed root
 * modules (round-8 C-1).
 *
 * The round-8 review planted a second preview route the round-7 universe
 * check could not see: a root-level shim that imports PreviewBody and
 * rewrites `preview.html`, loaded through an owned file's `import AliasShim
 * from '@shim'`, with the ONLY thing naming `@shim` sitting in the bundler's
 * alias table in `vite.config.ts` — a governed root module the gate already
 * read for imports yet never parsed for aliases. Every other route spelling
 * (static and dynamic import, re-export, glob, relative alias, root-relative
 * path, query suffix, case variant, symlink) was followed; the bundler's own
 * alias table was not, and a bare specifier nobody resolved classified
 * benign by default.
 *
 * The reading here is the same discipline the rest of this module runs: the
 * TypeScript parser decides what is an alias entry, a foldable replacement,
 * or a hole — and a shape the fold cannot read is UNRESOLVED, which the
 * consumers turn into a finding rather than a clean scan.
 * ---------------------------------------------------------------------- */

/** The paths a `path.resolve(…)` argument list folds to, or null. */
function foldResolveArguments(args, fold) {
	const folded = [];
	for (const argument of args) {
		const value = fold(argument);
		if (value === null) return null;
		folded.push(value);
	}
	if (folded.length === 0) return null;
	if (folded[0].startsWith('/')) return folded.join('/').replace(/\/{2,}/g, '/');
	const segments = [];
	for (const part of folded) {
		for (const segment of part.split('/')) {
			if (segment === '' || segment === '.') continue;
			if (segment === '..') {
				segments.pop();
				continue;
			}
			segments.push(segment);
		}
	}
	return segments.length === 0 ? '.' : `./${segments.join('/')}`;
}

/**
 * The `resolve.alias` entries a build-config source declares. Returns
 * `{ aliases, unresolved }`: each alias is `{ find: string | RegExp,
 * replacement: string }` with the replacement folded RELATIVE TO THE CONFIG
 * FILE (`./…` for paths built from the config's own directory; a literal
 * string passes through as written), and each unresolved entry is a short
 * text snippet of a shape the fold could not read. The governed root modules
 * sit at the repository root, so the audit strips the `./` to normalize.
 *
 * Covered spellings: an array of `{ find, replacement }` objects, an object
 * mapping find to replacement, shorthand and identifier-bound tables, string
 * and regex `find`, string/template/`path.resolve(root, …)` replacements,
 * and entries generated by spreading an array-literal `.map`. Anything else
 * — a computed find, an unresolvable replacement, a regex built by a call —
 * lands in `unresolved`, and the consumers fail closed on it.
 */
export function parseResolveAliases(source, { file = 'vite.config.ts', jsx = false } = {}) {
	const sourceFile = parseTypeScript(source, { file, jsx });
	const aliases = [];
	const unresolved = [];

	// The variable declarations the fold can chase, one hop at a time.
	const declarations = new Map();
	eachNode(sourceFile, (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			if (!declarations.has(node.name.text)) declarations.set(node.name.text, node.initializer);
		}
	});

	// The names `node:path` and `node:url` answer for, so a folded
	// `path.resolve(root, …)` is really the path module's and a folded root is
	// really `fileURLToPath(new URL('.', import.meta.url))` — a rebound name
	// stops the fold instead of feeding it a lie.
	const pathNames = new Set();
	const urlNames = new Set();
	eachNode(sourceFile, (node) => {
		if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
		const target = node.moduleSpecifier.text;
		const clause = node.importClause;
		if (target === 'node:path' || target === 'path') {
			if (clause?.name) pathNames.add(clause.name.text);
		}
		if (target === 'node:url' || target === 'url') {
			if (clause?.name) urlNames.add(clause.name.text);
			if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements)
					if (element.name.text === 'fileURLToPath' && !element.propertyName)
						urlNames.add(element.name.text);
			}
		}
	});

	/** The config's own directory: `fileURLToPath(new URL('.', import.meta.url))`. */
	const isConfigRootExpression = (node) => {
		if (!node) return false;
		if (
			!ts.isCallExpression(node) ||
			!ts.isIdentifier(node.expression) ||
			node.expression.text !== 'fileURLToPath' ||
			!urlNames.has('fileURLToPath') ||
			node.arguments.length !== 1 ||
			!ts.isNewExpression(node.arguments[0]) ||
			!ts.isIdentifier(node.arguments[0].expression) ||
			node.arguments[0].expression.text !== 'URL' ||
			!node.arguments[0].arguments ||
			!ts.isStringLiteral(node.arguments[0].arguments[0]) ||
			(node.arguments[0].arguments[0].text !== '.' && node.arguments[0].arguments[0].text !== './')
		)
			return false;
		// `import.meta.url` reaches the parser as a PropertyAccess over the
		// `import.meta` MetaProperty; a bare `import.meta` is admitted too.
		const urlArgument = node.arguments[0].arguments[1];
		return (
			Boolean(urlArgument) &&
			(ts.isMetaProperty(urlArgument) ||
				(ts.isPropertyAccessExpression(urlArgument) &&
					ts.isMetaProperty(urlArgument.expression) &&
					urlArgument.name.text === 'url'))
		);
	};

	/**
	 * Fold an expression to the path string it names, or null. `.` names the
	 * config's own directory. Depth-bounded, cycle-guarded, and conservative:
	 * any node the fold does not model is null, which the caller records as an
	 * unresolved entry.
	 */
	const fold = (node, locals, depth) => {
		if (!node || depth > 8) return null;
		if (ts.isParenthesizedExpression(node)) return fold(node.expression, locals, depth + 1);
		if (ts.isStringLiteral(node)) return node.text;
		if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		if (ts.isTemplateExpression(node)) {
			let text = node.head.text;
			for (const span of node.templateSpans) {
				const folded = fold(span.expression, locals, depth + 1);
				if (folded === null) return null;
				text += folded + span.literal.text;
			}
			return text;
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const left = fold(node.left, locals, depth + 1);
			const right = fold(node.right, locals, depth + 1);
			if (left === null || right === null) return null;
			return left + right;
		}
		if (ts.isIdentifier(node)) {
			if (locals && locals.has(node.text)) return locals.get(node.text);
			const initializer = declarations.get(node.text);
			if (!initializer) return null;
			if (isConfigRootExpression(initializer)) return '.';
			return fold(initializer, locals, depth + 1);
		}
		if (isConfigRootExpression(node)) return '.';
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'resolve' &&
			ts.isIdentifier(node.expression.expression) &&
			pathNames.has(node.expression.expression.text)
		)
			return foldResolveArguments(node.arguments, (argument) => fold(argument, locals, depth + 1));
		return null;
	};

	/** Read one `{ find, replacement }` object, or null on any unreadable part. */
	const readAliasEntry = (objectLiteral, locals) => {
		let findNode = null;
		let replacementNode = null;
		for (const property of objectLiteral.properties) {
			if (!ts.isPropertyAssignment(property)) return null;
			let key = null;
			if (ts.isIdentifier(property.name)) key = property.name.text;
			else if (ts.isStringLiteral(property.name)) key = property.name.text;
			else if (ts.isComputedPropertyName(property.name))
				key = fold(property.name.expression, locals, 0);
			if (key === null) return null;
			if (key === 'find') findNode = property.initializer;
			if (key === 'replacement') replacementNode = property.initializer;
		}
		if (!findNode || !replacementNode) return null;
		let find;
		if (ts.isRegularExpressionLiteral(findNode)) {
			const text = findNode.text;
			const lastSlash = text.lastIndexOf('/');
			try {
				find = new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1));
			} catch {
				return null;
			}
		} else {
			find = fold(findNode, locals, 0);
			if (find === null) return null;
		}
		const replacement = fold(replacementNode, locals, 0);
		if (replacement === null) return null;
		return { find, replacement };
	};

	/** The elements of the ARRAY spelling, including `.map`-generated runs. */
	const readAliasArray = (arrayLiteral, locals) => {
		for (const element of arrayLiteral.elements) {
			if (ts.isOmittedExpression(element)) continue;
			if (ts.isObjectLiteralExpression(element)) {
				const entry = readAliasEntry(element, locals);
				if (entry) aliases.push(entry);
				else unresolved.push(element.getText(sourceFile).slice(0, 80));
				continue;
			}
			if (ts.isSpreadElement(element) || ts.isSpreadAssignment(element)) {
				const expression = element.expression;
				// `...names.map((name) => ({ find: name, replacement: … }))`
				// over an array literal: bind the parameter to each element and
				// read the generated entries one by one.
				if (
					ts.isCallExpression(expression) &&
					ts.isPropertyAccessExpression(expression.expression) &&
					expression.expression.name.text === 'map' &&
					ts.isArrayLiteralExpression(expression.expression.expression) &&
					expression.arguments.length === 1 &&
					(ts.isArrowFunction(expression.arguments[0]) ||
						ts.isFunctionExpression(expression.arguments[0])) &&
					expression.arguments[0].parameters.length === 1 &&
					ts.isIdentifier(expression.arguments[0].parameters[0].name)
				) {
					const callback = expression.arguments[0];
					const parameterName = callback.parameters[0].name.text;
					let bodyObject = null;
					if (!ts.isBlock(callback.body)) bodyObject = unwrapValueNode(callback.body);
					else {
						const returns = [];
						eachNode(callback.body, (node) => {
							if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
						});
						if (returns.length === 1) bodyObject = unwrapValueNode(returns[0]);
					}
					if (!bodyObject || !ts.isObjectLiteralExpression(bodyObject)) {
						unresolved.push(element.getText(sourceFile).slice(0, 80));
						continue;
					}
					for (const item of expression.expression.expression.elements) {
						const folded = fold(item, locals, 0);
						if (folded === null) {
							unresolved.push(item.getText(sourceFile).slice(0, 80));
							continue;
						}
						const entry = readAliasEntry(
							bodyObject,
							new Map([...(locals ?? []), [parameterName, folded]])
						);
						if (entry) aliases.push(entry);
						else unresolved.push(bodyObject.getText(sourceFile).slice(0, 80));
					}
					continue;
				}
				unresolved.push(element.getText(sourceFile).slice(0, 80));
				continue;
			}
			unresolved.push(element.getText(sourceFile).slice(0, 80));
		}
	};

	/** The entries of the OBJECT spelling: every key is a find. */
	const readAliasObject = (objectLiteral, locals) => {
		for (const property of objectLiteral.properties) {
			if (!ts.isPropertyAssignment(property)) {
				unresolved.push(property.getText(sourceFile).slice(0, 80));
				continue;
			}
			let key = null;
			if (ts.isIdentifier(property.name)) key = property.name.text;
			else if (ts.isStringLiteral(property.name)) key = property.name.text;
			else if (ts.isComputedPropertyName(property.name))
				key = fold(property.name.expression, locals, 0);
			const replacement = key === null ? null : fold(property.initializer, locals, 0);
			if (key === null || replacement === null) {
				unresolved.push(property.getText(sourceFile).slice(0, 80));
				continue;
			}
			aliases.push({ find: key, replacement });
		}
	};

	let found = false;
	eachNode(sourceFile, (node) => {
		if (found) return;
		let initializer = null;
		if (
			ts.isPropertyAssignment(node) &&
			((ts.isIdentifier(node.name) && node.name.text === 'alias') ||
				(ts.isStringLiteral(node.name) && node.name.text === 'alias'))
		)
			initializer = node.initializer;
		else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'alias')
			initializer = declarations.get('alias') ?? null;
		if (!initializer) return;
		found = true;
		// An identifier-bound table: chase the declaration one hop.
		if (ts.isIdentifier(initializer)) {
			const bound = declarations.get(initializer.text);
			if (!bound) {
				unresolved.push(initializer.text);
				return;
			}
			initializer = bound;
		}
		if (ts.isArrayLiteralExpression(initializer)) readAliasArray(initializer, null);
		else if (ts.isObjectLiteralExpression(initializer)) readAliasObject(initializer, null);
		else unresolved.push(initializer.getText(sourceFile).slice(0, 80));
	});

	return { aliases, unresolved };
}

/**
 * Resolve a specifier through a normalized alias table — the audit supplies
 * entries whose replacements are repository-relative paths, or null for an
 * entry the scan matched but cannot follow (outside the repository root or
 * unreadable). Returns `{ kind: 'path', path }` when an entry routes the
 * specifier, `{ kind: 'unproven' }` when a matched entry cannot be followed,
 * and null when no entry matches. String finds follow the bundler's
 * semantics: exact match, or a prefix followed by `/`; regex finds apply
 * the bundler's own `specifier.replace(find, replacement)`.
 */
export function resolveAliasedSpecifier(specifier, resolveAliasEntries) {
	for (const entry of resolveAliasEntries ?? []) {
		if (entry.replacement === null || entry.replacement === undefined) {
			// An entry the scan cannot follow: it captures the specifier if its
			// find matches, and the route is unproven either way the consumer
			// needs.
			const matches =
				entry.find instanceof RegExp
					? entry.find.test(specifier)
					: specifier === entry.find || specifier.startsWith(`${entry.find}/`);
			if (matches) return { kind: 'unproven' };
			continue;
		}
		if (entry.find instanceof RegExp) {
			const flags = entry.find.flags.includes('g')
				? entry.find.flags.replace('g', '')
				: entry.find.flags;
			const find = new RegExp(entry.find.source, flags);
			if (!find.test(specifier)) continue;
			try {
				return { kind: 'path', path: specifier.replace(find, entry.replacement) };
			} catch {
				return { kind: 'unproven' };
			}
		}
		if (specifier === entry.find) return { kind: 'path', path: entry.replacement };
		if (specifier.startsWith(`${entry.find}/`))
			return {
				kind: 'path',
				path: `${entry.replacement}${specifier.slice(entry.find.length)}`,
			};
	}
	return null;
}
