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
 * (bypass C's `srcdoc` half) that `{@html}` scanning never sees.
 */
export function svelteSrcdoc(file, source) {
	const ast = parseSvelte(file, source);
	const findings = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
			for (const attribute of node.attributes ?? []) {
				if (attribute.type === 'Attribute' && attribute.name === 'srcdoc') {
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
				if (callee.name === 'insertAdjacentHTML' || callee.name === 'createContextualFragment') {
					findings.push(
						`${file} calls .${callee.name}(…) — an alternate raw-HTML sink that bypasses {@html} scanning`
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
						if (!ts.isObjectLiteralExpression(arg)) continue;
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
					}
					return;
				}
				return;
			}
		}
		if (ts.isJsxAttribute(node)) {
			if (node.name.text === 'srcdoc') {
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
 * R2-1 — the preview VALUE PATH, from `toDraftPreview` to the sink.
 *
 * Check 6 binds the sink file itself; the round-2 attack proved that was
 * not the whole path. A parent transform — a `$derived` that spreads
 * `preview` and rewrites `preview.html` before `<PreviewBody preview=…>`
 * — passed every check that only looked at PreviewBody.svelte, because the
 * value arriving at the sink was no longer lesser's bytes. This reading
 * closes the path: every `PreviewBody` invocation in owned source must pass
 * the preview value itself, verbatim, and that value must be bound only
 * from the `loadDraftPreview` result — never derived, spread, or written.
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
export function previewInvocationFindings(file, source) {
	const ast = parseSvelte(file, source);
	const invocations = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'Component' && node.name === 'PreviewBody') invocations.push(node);
		for (const key of Object.keys(node)) {
			if (key === 'parent') continue;
			visit(node[key]);
		}
	};
	visit(ast.fragment);
	if (invocations.length === 0) return [];

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
				const access = propertyName(node.left);
				if (
					access &&
					!access.computed &&
					access.name === 'html' &&
					ts.isIdentifier(access.object) &&
					access.object.text === identifier
				) {
					findings.push(
						`${file} writes to ${identifier}.html — a mutation can transform lesser's bytes before the sink`
					);
				}
				return;
			}
			if (ts.isSpreadAssignment(node)) {
				if (ts.isIdentifier(node.expression) && node.expression.text === identifier) {
					findings.push(
						`${file} spreads ${identifier} into a new object — reconstructing the DraftPreview between loadDraftPreview and the sink`
					);
				}
			}
		});
	}
	return findings;
}
