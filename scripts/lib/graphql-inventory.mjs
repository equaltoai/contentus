/**
 * The GraphQL documents contentus sends, named one by one, and the pinned lesser
 * schema they are judged against.
 *
 * WHY AN INVENTORY AND NOT A SEARCH. The first attempt at this control walked the
 * whole repository: a module-closure graph, a transport-channel model, a resolver,
 * a live probe. It was thousands of lines of machinery answering a question with
 * forty-six answers, and each layer was another place for the reading to be subtly
 * wrong about its own coverage. The list below is the coverage. It is checked, not
 * trusted — see the two exhaustiveness rules in `readInventory` — but it is a list a
 * reviewer can read in one sitting and compare against the repository by eye, which
 * no graph walk has ever been.
 *
 * WHAT THIS READER IS. `typescript` (already a devDependency, already what
 * `svelte-check` runs) parses each module; the reader takes top-level `const`
 * declarations whose initializer is a string or a template literal, and resolves a
 * template's `${…}` spans against other top-level string consts in the SAME file.
 * That is the whole grammar. It is closed on purpose, and it FAILS on anything
 * outside it rather than skipping — a document this reader cannot resolve is a
 * document nobody validated, and a gate that passes over one has certified silence.
 *
 * WHAT IT IS NOT. There is no module graph, no import resolution, no reachability
 * claim, and no runtime. Whether a document is *reached* by a build entry is a
 * different question from whether it is *valid*, and this control only answers the
 * second one. Conflating them is how the predecessor grew.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'graphql';
import ts from 'typescript';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCHEMA_PATH = 'contracts/lesser/graphql-schema.graphql';
export const PROVENANCE_PATH = 'contracts/lesser/provenance.json';

/**
 * Every module that declares a GraphQL operation contentus can send, and every
 * operation-bearing constant in it.
 *
 * Both columns are asserted. A constant here that the module does not declare is a
 * FAIL; a constant the module declares, that resolves to a document with an
 * operation in it, and that is missing here is also a FAIL. So this list cannot
 * quietly fall behind the source in either direction.
 */
export const DOCUMENT_INVENTORY = [
	{
		module: 'src/lib/cms/queries.ts',
		documents: [
			'ARTICLES_INDEX_QUERY',
			'ARTICLE_BY_SLUG_QUERY',
			'ARTICLE_NAVIGATION_QUERY',
			'CATEGORY_BY_SLUG_QUERY',
			'SERIES_BY_SLUG_QUERY',
		],
	},
	{
		module: 'src/lib/cms/discovery.ts',
		documents: ['SEARCH_ACCOUNTS_QUERY', 'SEARCH_HASHTAGS_QUERY', 'CUSTOM_EMOJIS_QUERY'],
	},
	{
		module: 'src/lib/cms/compose.ts',
		documents: [
			'CREATE_NOTE_MUTATION',
			'UPDATE_STATUS_MUTATION',
			'DELETE_OBJECT_MUTATION',
			'SCHEDULE_STATUS_MUTATION',
			'SOURCE_STATUS_QUERY',
			'VIEWER_QUERY',
		],
	},
	{
		module: 'src/lib/cms/media.ts',
		documents: ['UPLOAD_MEDIA_MUTATION', 'UPDATE_MEDIA_MUTATION'],
	},
	{
		module: 'src/lib/cms/review-contract.ts',
		documents: [
			'SHARED_DRAFT_REVIEWS_QUERY',
			'MY_DRAFT_REVIEWS_QUERY',
			'DRAFT_REVIEW_QUERY',
			'DRAFT_PREVIEW_QUERY',
			'DRAFT_OWNERSHIP_QUERY',
			'SUBMIT_DRAFT_REVIEW_MUTATION',
			'PUBLISH_DRAFT_MUTATION',
			'SCHEDULE_DRAFT_MUTATION',
		],
	},
	{
		module: 'src/lib/messaging/queries.ts',
		documents: [
			'CONVERSATIONS_QUERY',
			'CONVERSATION_QUERY',
			'CONVERSATION_MESSAGES_QUERY',
			'SEND_MESSAGE_MUTATION',
			'CREATE_CONVERSATION_MUTATION',
			'ACCEPT_MESSAGE_REQUEST_MUTATION',
			'DECLINE_MESSAGE_REQUEST_MUTATION',
			'DELETE_CONVERSATION_MUTATION',
			'DELETE_MESSAGE_MUTATION',
			'MARK_CONVERSATION_READ_MUTATION',
			'SEARCH_ACTORS_QUERY',
			'CONVERSATION_UPDATES_SUBSCRIPTION',
		],
	},
	{
		module: 'src/lib/timelines/contract.ts',
		documents: ['TIMELINE_QUERY', 'ACTOR_QUERY', 'TIMELINE_UPDATES_SUBSCRIPTION'],
	},
	{
		module: 'src/lib/agents/contract.ts',
		documents: ['AGENTS_ROSTER_QUERY', 'AGENT_DETAIL_QUERY', 'MY_AGENTS_QUERY'],
	},
	{
		module: 'src/lib/drones/contract.ts',
		documents: [
			'DRONE_WORKFLOW_QUERY',
			'DRONE_REGISTRATION_POLICY_QUERY',
			'DELEGATE_TO_AGENT_MUTATION',
		],
	},
];

/**
 * The pinned schema, with its integrity re-checked before anything is judged by it.
 *
 * INTEGRITY, NOT PROVENANCE. This recomputes the digest of the bytes in this
 * repository against `provenance.json`, so a schema edited in the same pull request
 * as the documents it judges fails here. It does not reach upstream and does not
 * claim to: `blob_sha1` in the pin is git's own object id for these bytes, and
 * comparing it against equaltoai/lesser is the provenance step. Reporting a green
 * offline run as proof of provenance is the one thing this function must never be
 * quoted as doing.
 */
export function loadPinnedSchema() {
	const provenance = JSON.parse(readFileSync(join(repoRoot, PROVENANCE_PATH), 'utf8'));
	const bytes = readFileSync(join(repoRoot, SCHEMA_PATH));
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (provenance.artifact?.path !== SCHEMA_PATH)
		throw new Error(
			`${PROVENANCE_PATH} describes ${provenance.artifact?.path}, not ${SCHEMA_PATH}`
		);
	if (bytes.length !== provenance.artifact?.bytes)
		throw new Error(
			`${SCHEMA_PATH} is ${bytes.length} bytes; the pin records ${provenance.artifact?.bytes}`
		);
	if (sha256 !== provenance.artifact?.sha256)
		throw new Error(
			`${SCHEMA_PATH} does not match its pin.\n` +
				`  pinned: ${provenance.artifact?.sha256}\n  actual: ${sha256}\n` +
				'Move the pin only for a lesser ref you fetched and re-validated in the same commit.'
		);

	return { sdl: bytes.toString('utf8'), provenance, sha256 };
}

/** `query Foo`, `mutation Foo`, `subscription Foo` — used only to fail closed. */
const OPERATION_TEXT = /\b(?:query|mutation|subscription)\s+[A-Za-z_]/;

/**
 * Top-level string constants of one module, with template interpolation resolved.
 *
 * Returns `{ resolved, unresolved }`. `unresolved` carries the reason, and the
 * caller decides — the point of separating them is that "this reader could not
 * resolve a constant that looks like an operation" must be an error, and a reader
 * that threw here could not distinguish that from an ordinary non-GraphQL string.
 */
export function readModuleStringConstants(modulePath) {
	// `resolve` rather than `join`, so a caller may pass an absolute path. The
	// exhaustiveness probes read scratch modules in a temp directory: asserting what
	// this reader does with a malformed document by planting one in THIS repository
	// would mean the gate's own subject was the fixture.
	const absolute = resolve(repoRoot, modulePath);
	const source = ts.createSourceFile(
		absolute,
		readFileSync(absolute, 'utf8'),
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.TS
	);

	const resolved = new Map();
	const unresolved = new Map();
	const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
			const name = declaration.name.text;
			const init = declaration.initializer;
			const line = lineOf(declaration);

			if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
				resolved.set(name, { text: init.text, line });
				continue;
			}
			if (!ts.isTemplateExpression(init)) continue;

			let text = init.head.text;
			let failure = null;
			for (const span of init.templateSpans) {
				if (!ts.isIdentifier(span.expression)) {
					failure = `interpolates a ${ts.SyntaxKind[span.expression.kind]}, not a plain identifier`;
					break;
				}
				const referenced = resolved.get(span.expression.text);
				if (!referenced) {
					failure =
						`interpolates \`${span.expression.text}\`, which is not a top-level string ` +
						'constant declared earlier in this file';
					break;
				}
				text += referenced.text + span.literal.text;
			}

			// The raw text with every span blanked, so a constant this reader could not
			// resolve can still be recognised as one that carries an operation.
			const raw = init.getText(source);
			if (failure) unresolved.set(name, { line, failure, raw });
			else resolved.set(name, { text, line });
		}
	}

	return { resolved, unresolved };
}

/** Does this string parse as a GraphQL document that contains an operation? */
export function operationNames(text) {
	let document;
	try {
		document = parse(text);
	} catch {
		return null;
	}
	const operations = document.definitions.filter((d) => d.kind === 'OperationDefinition');
	if (operations.length === 0) return null;
	return operations.map((d) => `${d.operation} ${d.name?.value ?? '(anonymous)'}`);
}

/**
 * Every contentus-authored `.ts` module under `src/`.
 *
 * "Contentus-authored" is decided by components.json — the `greater` CLI's own
 * record of the files it manages — rather than by a hand-kept path list here. Two
 * lists of vendored paths would be two lists to keep in step, and the one that fell
 * behind would be the one deciding what this gate looks at.
 */
export function ownedModules(trackedFiles) {
	const components = JSON.parse(readFileSync(join(repoRoot, 'components.json'), 'utf8'));
	const aliases = components.aliases ?? {};
	const managed = new Set();
	for (const entry of components.installed ?? []) {
		for (const { path } of entry.checksums ?? []) {
			// The registry spells shared modules `lib/lib/<name>`; the `lib` alias target
			// takes the basename. Everything else is `<alias>/<rest>`.
			if (path.startsWith('lib/lib/')) {
				managed.add(`${aliases.lib}/${path.slice('lib/lib/'.length)}`);
				continue;
			}
			const [head, ...rest] = path.split('/');
			// `shared/<mod>/…` is emitted into the components alias.
			const base = head === 'shared' ? aliases.components : aliases[head];
			if (base) managed.add(`${base}/${rest.join('/')}`);
		}
	}
	// Per-file, not per-directory. The `lib` alias target IS `src/lib`, contentus's own
	// directory — the CLI emits shared modules as loose siblings of contentus source —
	// so excluding alias ROOTS would exclude nearly the whole application and leave this
	// sweep reporting a comfortable number about almost nothing.
	return (
		trackedFiles
			.map((file) => relative(repoRoot, resolve(repoRoot, file)).split(sep).join('/'))
			.filter((file) => file.startsWith('src/') && /\.(?:ts|mts|cts)$/.test(file))
			.filter((file) => !managed.has(file))
			// A tracked path with no file on disk — a deletion not yet staged, as the
			// greater-v0.13.1 prune left — has no content to scan and no document to hide.
			.filter((file) => existsSync(join(repoRoot, file)))
			.sort()
	);
}

/**
 * Resolve the inventory to documents, and prove the inventory is the coverage.
 *
 * Four ways this fails, and all four are things a list-without-checks would have
 * passed over in silence:
 *
 *   1. an inventoried constant the module does not declare;
 *   2. an inventoried constant that does not resolve to a GraphQL operation;
 *   3. an operation-bearing constant in an inventoried module that is NOT listed;
 *   4. an operation-bearing constant in a contentus-authored module that the
 *      inventory does not mention at all.
 *
 * Plus the fail-closed case: a constant this reader could not resolve whose source
 * text carries an operation keyword. That is not "not a document" — it is "unknown",
 * and unknown is never green.
 */
export function readInventory(trackedFiles) {
	const problems = [];
	const documents = [];
	const inventoried = new Map(DOCUMENT_INVENTORY.map((e) => [e.module, e.documents]));

	for (const file of ownedModules(trackedFiles)) {
		const listed = inventoried.get(file);
		const { resolved, unresolved } = readModuleStringConstants(file);

		for (const [name, info] of unresolved) {
			if (OPERATION_TEXT.test(info.raw))
				problems.push(
					`${file}:${info.line} ${name} carries a GraphQL operation but ${info.failure}. ` +
						'Rewrite it within the reader’s grammar (a template whose spans are ' +
						'identifiers of top-level string constants in the same file) — a document ' +
						'this gate cannot resolve is a document it cannot validate.'
				);
		}

		for (const [name, info] of resolved) {
			const operations = operationNames(info.text);
			if (!operations) continue;
			if (!listed)
				problems.push(
					`${file}:${info.line} declares GraphQL operation(s) ${operations.join(', ')} in ` +
						`${name}, but ${file} is not in DOCUMENT_INVENTORY. Add the module and its documents.`
				);
			else if (!listed.includes(name))
				problems.push(
					`${file}:${info.line} declares ${name} (${operations.join(', ')}), which is not listed ` +
						`for ${file} in DOCUMENT_INVENTORY. An unlisted document is an unvalidated document.`
				);
			else documents.push({ module: file, name, text: info.text, line: info.line, operations });
		}

		if (!listed) continue;
		for (const name of listed) {
			if (resolved.has(name)) {
				if (!operationNames(resolved.get(name).text))
					problems.push(
						`${file}: ${name} is inventoried but does not parse as a GraphQL document with an ` +
							'operation in it. Remove it from the inventory, or fix the document.'
					);
				continue;
			}
			problems.push(
				unresolved.has(name)
					? `${file}: ${name} is inventoried but ${unresolved.get(name).failure}.`
					: `${file}: ${name} is inventoried but no such top-level string constant is declared.`
			);
		}
	}

	for (const module of inventoried.keys())
		if (!ownedModules(trackedFiles).includes(module))
			problems.push(
				`DOCUMENT_INVENTORY names ${module}, which is not a contentus-authored .ts module under ` +
					'src/ (it is absent, vendored, or not tracked).'
			);

	return { documents, problems };
}
