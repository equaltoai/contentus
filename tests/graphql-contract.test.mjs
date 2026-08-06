import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSchema, parse, validate } from 'graphql';

import { auditSeamGraph } from '../scripts/audit-seam-graph.mjs';
import { documentsIn, TRANSPORT_ROOTS } from '../scripts/lib/graphql-documents.mjs';
import {
	isScript,
	reachableFrom,
	resolveClosure,
	resolverOver,
} from '../scripts/lib/module-closure.mjs';
import { liveScript } from '../scripts/lib/module-imports.mjs';
import { createViteResolver } from '../scripts/lib/module-resolution.mjs';
import { gitBlobOid } from '../scripts/lib/schema-pin.mjs';
import { toAuthorSummary, toBlogFaceArticle, toArticleDetail } from '../src/lib/cms/articles.ts';
import { ARTICLES_INDEX_QUERY, ARTICLE_BY_SLUG_QUERY } from '../src/lib/cms/queries.ts';

/**
 * The regression matrix for the executable-contract gate.
 *
 * WHAT WENT WRONG, AND WHY IT COULD. Contentus selected `Actor.avatarUrl` on both
 * public article documents. Lesser's `type Actor` has never published that field —
 * it publishes `avatar`. The name came from the vendored greater adapter's own
 * `Account` projection, and it survived a full milestone because the only things
 * examining these documents were fixtures written to match them. Every test was
 * green. `avatarUrl: null` went in, `avatarUrl: null` came out, and the assertion
 * that compared them was true. A mock that agrees with a wrong document is not
 * evidence about a contract; it is the same mistake entered twice, agreeing with
 * itself.
 *
 * So the tests below never assert a document against a fixture. They assert it
 * against lesser's schema, and they assert the GATE that does so actually bites.
 *
 * EVERY GREEN IS PAIRED WITH A RED. A gate that passes because nothing reached it
 * is indistinguishable from a gate that passes because what reached it was
 * correct. So each case that must be silent is run again with the defect present,
 * and the gate must name it. That pairing is the only thing separating this file
 * from the fixtures that let the original defect through.
 *
 * HOW THE GATE IS RUN. Against synthetic repositories in temp directories, not
 * against this one: the gate takes its root from `process.cwd()`, so a tree of a
 * schema, a pin and a couple of modules is the whole harness — and the code under
 * test is this repository's at its current bytes. Nothing here touches the working
 * tree; `node --test` runs files concurrently and a build may be running beside it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** A small schema with the one shape that matters: an Actor with `avatar`. */
const SCHEMA = `
scalar Cursor

type Actor {
  id: ID!
  username: String!
  displayName: String
  avatar: String
}

type Article {
  id: ID!
  slug: String!
  title: String!
  author: Actor!
}

type Query {
  articles: [Article!]!
}

extend type Query {
  articleBySlug(slug: String!): Article
}
`;

function sha256(text) {
	return createHash('sha256').update(text).digest('hex');
}

/**
 * A stand-in for `src/lib/cms/graphql.ts` — the module the transport analysis is
 * ROOTED at. Every synthetic tree gets one, because a channel is now an export of
 * a named module rather than a name a call site happens to use, and a tree
 * without it would be testing a graph with no roots.
 */
const TRANSPORT_MODULE = `
export async function graphqlRequest(query, variables = {}, options = {}) {
	return { data: null, errors: [], query, variables, options };
}
`;

const SUBSCRIPTION_MODULE = `
export function subscribe(options) {
	return () => options;
}
`;

/**
 * Vite config for a synthetic tree.
 *
 * The gate resolves with VITE, so the aliases a tree declares are the aliases the
 * gate follows — the same relationship the real repository has with its own
 * `vite.config.ts`. Nothing is restated in the gate.
 */
const VITE_CONFIG = `
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default {
	resolve: {
		alias: [{ find: '$lib', replacement: path.resolve(root, 'src/lib') }],
	},
};
`;

/**
 * A synthetic repository: a schema, a pin that matches it, a Vite config, the two
 * transport modules, an entry point, and whatever modules the case needs.
 */
function tree({
	schema = SCHEMA,
	files = {},
	upstream = [],
	pin = {},
	entries = ['src/entry.ts'],
	entrySource = null,
	viteConfig = VITE_CONFIG,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'contentus-graphql-'));
	const write = (relative, content) => {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	};

	if (viteConfig) write('vite.config.ts', viteConfig);
	write('src/lib/cms/graphql.ts', TRANSPORT_MODULE);
	write('src/lib/timelines/subscription.ts', SUBSCRIPTION_MODULE);
	if (entrySource !== null) write('src/entry.ts', entrySource);

	write('contracts/lesser/graphql-schema.graphql', schema);
	write(
		'contracts/lesser/provenance.json',
		JSON.stringify(
			{
				schema: {
					repository: 'https://github.com/equaltoai/lesser',
					branch: 'staging',
					ref: 'e710ffb31a983b2ad993845dca7d3263b81de100',
					upstream_path: 'docs/contracts/graphql-schema.graphql',
					pinned_path: 'contracts/lesser/graphql-schema.graphql',
					sha256: sha256(schema),
					bytes: Buffer.byteLength(schema),
					git_blob_sha1: gitBlobOid(Buffer.from(schema)),
					...pin,
				},
				document_roots: {
					paths: ['src'],
					extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.svelte'],
				},
				build_entry_points: { paths: entries },
				upstream_trees: upstream,
			},
			null,
			2
		)
	);

	for (const [relative, content] of Object.entries(files)) write(relative, content);
	// An entry has to exist or the boundary walk starts nowhere; the gate refuses
	// a missing one, so a case that declares no entry source gets an empty file.
	for (const entry of entries) {
		if (!existsSync(join(root, entry))) write(entry, '');
	}
	return root;
}

function runGate(root, argv = []) {
	// SPELLED HERE, IN THIS FILE'S OWN FRAME, and that is a control rather than a
	// duplication. CON-5 binds this child to the file it runs by checking the
	// disclosure's `binds` against the target the SITE names — and which file a
	// path names is decided by the base it is resolved against as much as by its
	// text. A relative literal would be resolved in the child's working directory,
	// and a path composed from `REPO` above would be resolved against a base no
	// reading can see at the call; either way the binding becomes a claim about
	// whichever file the walk guessed at. `import.meta.url` is a base no working
	// directory moves. The tree under test travels as `--root` for the same reason:
	// it is the argument that varies, so it is the argument that is computed.
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL('../scripts/audit-graphql-contract.mjs', import.meta.url)),
			'--root',
			root,
			...argv,
		],
		{ encoding: 'utf8' }
	);
	return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function withTree(options, assertions) {
	const root = tree(options);
	try {
		assertions(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A module that declares and sends one document built from a field fragment. */
function articleModule(avatarField) {
	return `
const AUTHOR = \`
	id
	username
	${avatarField}
\`;

export const ARTICLES = \`
	query SyntheticArticles {
		articles { id slug title author { \${AUTHOR} } }
	}
\`;

export async function load(graphqlRequest) {
	return graphqlRequest(ARTICLES, {});
}
`;
}

/* =========================================================================
 * The defect itself, against lesser's real pinned schema
 * ====================================================================== */

const REAL_SCHEMA = buildSchema(
	readFileSync(join(REPO, 'contracts/lesser/graphql-schema.graphql'), 'utf8')
);

test('both public article documents validate against lesser’s pinned schema', () => {
	for (const [name, document] of [
		['ARTICLES_INDEX_QUERY', ARTICLES_INDEX_QUERY],
		['ARTICLE_BY_SLUG_QUERY', ARTICLE_BY_SLUG_QUERY],
	]) {
		const errors = validate(REAL_SCHEMA, parse(document));
		assert.deepEqual(
			errors.map((error) => error.message),
			[],
			`${name} must validate against lesser's schema`
		);
	}
});

test('the schema is what rejects avatarUrl — the assertion above is not vacuous', () => {
	// The paired red. If `avatarUrl` validated too, the test above would pass no
	// matter which field the query selected, and this whole file would be
	// decoration. Re-introducing exactly the shipped defect must be rejected, and
	// rejected by NAME, so the gate's message is the one a reader would act on.
	const regressed = ARTICLES_INDEX_QUERY.replace(/\bavatar\b/, 'avatarUrl');
	assert.notEqual(
		regressed,
		ARTICLES_INDEX_QUERY,
		'the substitution must actually change the text'
	);

	const errors = validate(REAL_SCHEMA, parse(regressed));
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /Cannot query field "avatarUrl" on type "Actor"/);
});

test('every author field the documents select is a field lesser publishes', () => {
	// Guards the direction the `avatarUrl` defect came from: a field name borrowed
	// from greater's Account projection rather than from lesser's Actor.
	const actor = REAL_SCHEMA.getType('Actor').getFields();
	assert.ok(Object.hasOwn(actor, 'avatar'));
	assert.ok(!Object.hasOwn(actor, 'avatarUrl'));

	for (const document of [ARTICLES_INDEX_QUERY, ARTICLE_BY_SLUG_QUERY]) {
		assert.ok(/\bavatar\b/.test(document), 'the byline avatar is still selected');
		assert.ok(!/\bavatarUrl\b/.test(document), 'and never under greater’s name');
	}
});

/* =========================================================================
 * Normalization: lesser's field name in, the face's field name out
 * ====================================================================== */

test('an author is normalized from lesser’s `avatar`, not from `avatarUrl`', () => {
	const fromLesser = toAuthorSummary({
		id: 'actor-1',
		username: 'ada',
		displayName: 'Ada',
		avatar: 'https://cdn.example.test/ada.webp',
	});

	assert.equal(fromLesser.avatar, 'https://cdn.example.test/ada.webp');

	// The paired red, and the one the original defect would have passed: a
	// response carrying greater's field name must NOT produce an avatar, because
	// lesser never sends that key. Accepting both would re-create the bug as a
	// tolerated alias.
	const fromGreaterShape = toAuthorSummary({
		id: 'actor-1',
		username: 'ada',
		displayName: 'Ada',
		avatarUrl: 'https://cdn.example.test/ada.webp',
	});
	assert.equal(fromGreaterShape.avatar, null);
});

test('the view-model boundary is where `avatar` becomes `avatarUrl`', () => {
	// The rename is legitimate and belongs at exactly one place: the adapter that
	// feeds the vendored blog face, which reads `avatarUrl`. What must not happen
	// is lesser's response shape carrying the face's vocabulary.
	const article = toArticleDetail({
		id: 'article-1',
		slug: 'a-slug',
		title: 'A title',
		content: '<p>rendered by lesser</p>',
		contentFormat: 'HTML',
		readingTimeMinutes: 3,
		wordCount: 400,
		publishedAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		categories: [],
		tableOfContents: [],
		author: {
			id: 'actor-1',
			username: 'ada',
			displayName: 'Ada',
			avatar: 'https://cdn.example.test/ada.webp',
		},
	});

	assert.equal(article.author.avatar, 'https://cdn.example.test/ada.webp');

	const faceInput = toBlogFaceArticle(article, { kind: 'render' });
	assert.equal(faceInput.author.avatarUrl, 'https://cdn.example.test/ada.webp');

	// And the value genuinely travelled, rather than both ends being undefined —
	// which is precisely how the shipped defect stayed invisible.
	assert.notEqual(faceInput.author.avatarUrl, undefined);
});

/* =========================================================================
 * The gate bites: unknown field
 * ====================================================================== */

test('an unknown field fails the gate, and the same tree with the real field passes', () => {
	withTree({ files: { 'src/lib/articles.ts': articleModule('avatarUrl') } }, (root) => {
		const bad = runGate(root);
		assert.equal(bad.status, 1);
		assert.match(bad.out, /Cannot query field "avatarUrl" on type "Actor"/);
		assert.match(bad.out, /graphql-contract: FAIL/);
	});

	withTree({ files: { 'src/lib/articles.ts': articleModule('avatar') } }, (root) => {
		const good = runGate(root);
		assert.equal(good.status, 0, good.out);
		assert.match(good.out, /graphql-contract: PASS/);
	});
});

test('the unknown field is caught inside an IMPORTED fragment, not only a local one', () => {
	// The reader folds a document in the scope that OWNS the interpolation. An
	// earlier version folded imported constants against the IMPORTING module's
	// bindings, where the fragment name does not exist — so `ARTICLES_INDEX_QUERY`
	// resolved to nothing and was reported as unreadable rather than validated.
	// Every executor site in cms/loaders.ts went unchecked that way. This is that
	// regression: the defect lives in another module than the document.
	const files = {
		'src/lib/fragments.ts': 'export const AUTHOR = `\n\tid\n\tavatarUrl\n`;\n',
		'src/lib/articles.ts': `
import { AUTHOR } from './fragments.ts';

export const ARTICLES = \`
	query SyntheticArticles {
		articles { id author { \${AUTHOR} } }
	}
\`;
`,
	};

	withTree({ files }, (root) => {
		const result = runGate(root);
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /Cannot query field "avatarUrl" on type "Actor"/);
		// Named at the document, which is where a reader would go to fix it.
		assert.match(result.out, /src\/lib\/articles\.ts/);
	});

	withTree(
		{
			files: {
				...files,
				'src/lib/fragments.ts': 'export const AUTHOR = `\n\tid\n\tavatar\n`;\n',
			},
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 0, result.out);
		}
	);
});

/* =========================================================================
 * The gate bites: stale or wrong schema
 * ====================================================================== */

test('a schema edited without moving the pin fails', () => {
	withTree({ files: { 'src/lib/articles.ts': articleModule('avatar') } }, (root) => {
		assert.equal(runGate(root).status, 0);

		// Someone adds the field they wanted to the pinned copy instead of routing
		// it upstream. The document would now validate; the digest is what refuses.
		writeFileSync(
			join(root, 'contracts/lesser/graphql-schema.graphql'),
			SCHEMA.replace('avatar: String', 'avatar: String\n  avatarUrl: String')
		);

		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.match(result.out, /does not match its pinned sha256/);
		// And the git blob OID moves with the bytes, which is the value the
		// upstream check compares against lesser.
		assert.match(result.out, /does not hash to its pinned git blob OID/);
	});
});

test('a pin moved without the schema fails', () => {
	withTree(
		{
			files: { 'src/lib/articles.ts': articleModule('avatar') },
			pin: { sha256: 'f'.repeat(64) },
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1);
			assert.match(result.out, /does not match its pin/);
		}
	);
});

test('a byte count that disagrees with the file fails even when the digest is right', () => {
	withTree(
		{
			files: { 'src/lib/articles.ts': articleModule('avatar') },
			pin: { bytes: 1 },
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1);
			assert.match(result.out, /bytes/);
		}
	);
});

test('a WRONG schema — valid, pinned, but not the contract — fails the documents', () => {
	// The stale case that a digest alone cannot catch: a schema that is internally
	// consistent and correctly pinned, but older than the document. `avatar` has
	// not been introduced yet, so the document that depends on it must fail.
	const older = SCHEMA.replace('  avatar: String\n', '');
	withTree({ schema: older, files: { 'src/lib/articles.ts': articleModule('avatar') } }, (root) => {
		const result = runGate(root);
		assert.equal(result.status, 1);
		assert.match(result.out, /Cannot query field "avatar" on type "Actor"/);
	});
});

/* =========================================================================
 * The gate bites: omission
 * ====================================================================== */

test('a document the reader cannot read fails rather than being skipped', () => {
	// The omission case. A document assembled at runtime reaches the transport,
	// and no static reader can say what it sends. Silence here would be the whole
	// failure mode this gate exists to prevent: the one document nobody checked
	// looks exactly like the ninety that passed.
	const files = {
		'src/lib/dynamic.ts': `
export async function load(graphqlRequest, field) {
	const document = 'query Synthetic { articles { ' + field + ' } }';
	return graphqlRequest(document, {});
}
`,
	};

	withTree({ files }, (root) => {
		const result = runGate(root);
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /could not determine what GraphQL text this sends/);
	});
});

test('a malformed document fails, and is reported as malformed', () => {
	const files = {
		'src/lib/broken.ts': 'export const BROKEN = `\n\tquery Synthetic {\n\t\tarticles { id\n\t`;\n',
	};

	withTree({ files }, (root) => {
		const result = runGate(root);
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /Syntax Error/);
	});
});

test('a document inside a Svelte component is discovered', () => {
	// The file-set question. A walk keyed on `.ts` would report PASS over a
	// component that sends a broken document — and this repository really does
	// declare one in `src/lib/timelines/TimelineFeed.svelte`, so the extension
	// list is load-bearing rather than defensive.
	const component = `<script lang="ts">
	const ARTICLES = \`
		query SyntheticFromComponent {
			articles { id author { avatarUrl } }
		}
	\`;
	export { ARTICLES };
</script>

<p>markup</p>
`;

	withTree({ files: { 'src/lib/Feed.svelte': component } }, (root) => {
		const result = runGate(root);
		assert.equal(result.status, 1, result.out);
		assert.match(result.out, /Cannot query field "avatarUrl" on type "Actor"/);
		assert.match(result.out, /Feed\.svelte/);
	});
});

/* =========================================================================
 * The gate bites: the upstream boundary
 * ====================================================================== */

const UPSTREAM_TREE = {
	path: 'src/vendored/',
	reason: 'synthetic upstream tree',
	boundary: 'no module outside this tree may reach a document-bearing module inside it',
	documents: { 'src/vendored/adapter.ts': { documents: 1, unresolved: 0 } },
};

/** An upstream module carrying a document written against somebody else's schema. */
const UPSTREAM_MODULE =
	'export const FOREIGN = `\n\tquery Foreign { accounts { avatarUrl } }\n`;\n';

test('an upstream document is excluded by a counted disclosure, not silently', () => {
	withTree(
		{ files: { 'src/vendored/adapter.ts': UPSTREAM_MODULE }, upstream: [UPSTREAM_TREE] },
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 0, result.out);
			// The count is reported, so the exclusion is visible in the evidence
			// rather than being an absence a reader has to notice.
			assert.match(result.out, /1 documents and 0 unreadable candidates disclosed/);
		}
	);
});

test('an UNDECLARED upstream document fails — the disclosure is a count, not a permission', () => {
	withTree(
		{
			files: {
				'src/vendored/adapter.ts': UPSTREAM_MODULE,
				'src/vendored/second.ts': 'export const OTHER = `\n\tquery Other { nope { id } }\n`;\n',
			},
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /is not named in contracts\/lesser\/provenance\.json/);
		}
	);
});

test('a disclosure that no longer describes anything fails', () => {
	withTree(
		{
			files: { 'src/vendored/adapter.ts': 'export const NOTHING = 1;\n' },
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /carries no GraphQL document/);
		}
	);
});

test('importing an excluded document-bearing module fails — the exclusion is checked, not assumed', () => {
	// This is what makes the disclosure safe. Excluding the vendored tree is only
	// defensible while contentus cannot execute what is in it; the moment a
	// contentus module reaches one, the document is contentus's to answer for.
	withTree(
		{
			entrySource: "import { FOREIGN } from './lib/consumer.ts';\nconsole.log(FOREIGN);\n",
			files: {
				'src/vendored/adapter.ts': UPSTREAM_MODULE,
				'src/lib/consumer.ts':
					"import { FOREIGN } from '../vendored/adapter.ts';\nexport { FOREIGN };\n",
			},
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /IS\s+reachable by import from contentus source/);
		}
	);

	// Paired green: the identical tree without the import. Proves the failure came
	// from the edge, not from the module merely existing.
	withTree(
		{
			entrySource: "import { unrelated } from './lib/consumer.ts';\nconsole.log(unrelated);\n",
			files: {
				'src/vendored/adapter.ts': UPSTREAM_MODULE,
				'src/lib/consumer.ts': 'export const unrelated = 1;\n',
			},
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			assert.equal(runGate(root).status, 0);
		}
	);
});

test('a `.js` specifier resolving to a `.ts` file is followed — the resolver is Vite’s', () => {
	// THE EXACT EDGE THE REVIEW DEMONSTRATED. `src/lib/routes/ArticleReader.svelte`
	// imports `$lib/greater/faces/blog/components/Article/index.js` and the file on
	// disk is `index.ts`. The old candidate list tested `index.js`, then
	// `index.js.ts`, and answered nothing — so an outside module importing a
	// document-bearing vendored `adapter.ts` failed as required, while re-spelling
	// the SAME import `adapter.js` made the gate PASS. Both spellings must bite.
	for (const specifier of ['../vendored/adapter.ts', '../vendored/adapter.js']) {
		withTree(
			{
				entrySource: "import { FOREIGN } from './lib/consumer.ts';\nconsole.log(FOREIGN);\n",
				files: {
					'src/vendored/adapter.ts': UPSTREAM_MODULE,
					'src/lib/consumer.ts': `import { FOREIGN } from '${specifier}';\nexport { FOREIGN };\n`,
				},
				upstream: [UPSTREAM_TREE],
			},
			(root) => {
				const result = runGate(root);
				assert.equal(result.status, 1, `${specifier} must be followed:\n${result.out}`);
				assert.match(result.out, /IS\s+reachable by import from contentus source/);
			}
		);
	}
});

test('an ALIASED specifier and a directory barrel are followed', () => {
	// `$lib/…` and `./dir` (meaning `./dir/index.ts`) are how this repository
	// actually imports; a resolver that missed either would leave the boundary
	// blind along the paths it is most often crossed.
	withTree(
		{
			entrySource: "import { FOREIGN } from '$lib/consumer.ts';\nconsole.log(FOREIGN);\n",
			files: {
				'src/vendored/index.ts': "export * from './adapter.js';\n",
				'src/vendored/adapter.ts': UPSTREAM_MODULE,
				'src/lib/consumer.ts': "import { FOREIGN } from '../vendored';\nexport { FOREIGN };\n",
			},
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /IS\s+reachable by import from contentus source/);
		}
	);
});

test('a computed dynamic import inside the reachable closure fails closed', () => {
	// `import(name)` names nothing a static read can follow, so the boundary cannot
	// say what is past it. The review noted computed imports were absent from the
	// walk entirely; absence read as "nothing there".
	withTree(
		{
			entrySource: "import './lib/consumer.ts';\n",
			files: {
				'src/vendored/adapter.ts': UPSTREAM_MODULE,
				'src/lib/consumer.ts':
					'export async function pick(name) {\n\treturn import(`../vendored/${name}.ts`);\n}\n',
			},
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /a load whose target no static read can name/);
		}
	);
});

test('an unresolvable specifier that NAMES A PATH fails, while an uninstalled package does not', () => {
	// The distinction is what keeps this rule about the boundary rather than about
	// upstream's dependencies. A bare package this repository does not install
	// cannot be a file inside the vendored tree; a `./…` that will not resolve is
	// a genuine hole in the closure.
	withTree(
		{
			entrySource: "import './lib/consumer.ts';\n",
			files: { 'src/lib/consumer.ts': "import './does-not-exist.ts';\nexport const x = 1;\n" },
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /names a path in this tree/);
		}
	);

	withTree(
		{
			entrySource: "import './lib/consumer.ts';\n",
			files: {
				'src/lib/consumer.ts': "import 'some-uninstalled-package';\nexport const x = 1;\n",
			},
		},
		(root) => {
			assert.equal(runGate(root).status, 0);
		}
	);
});

test('reachability is transitive — one module in between does not launder the import', () => {
	withTree(
		{
			entrySource: "import { FOREIGN } from './lib/consumer.ts';\nconsole.log(FOREIGN);\n",
			files: {
				'src/vendored/adapter.ts': UPSTREAM_MODULE,
				'src/lib/middle.ts': "export * from '../vendored/adapter.ts';\n",
				'src/lib/consumer.ts': "import { FOREIGN } from './middle.ts';\nexport { FOREIGN };\n",
			},
			upstream: [UPSTREAM_TREE],
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /reachable by import from contentus source/);
		}
	);
});

/* =========================================================================
 * The reader itself
 * ====================================================================== */

test('prose that contains the word "query" is not reported as a broken document', () => {
	// The false-positive direction, which costs exactly what a miss costs: the
	// pressure a noisy gate creates is to loosen it. `src/lib/agents/contract.ts`
	// really does say "The agent query could not be completed."
	const source = `
const MESSAGE = 'The agent query could not be completed.';
const OTHER = 'This instance did not answer the agent query.';
export const REAL = \`
	query Synthetic { articles { id } }
\`;
export { MESSAGE, OTHER };
`;

	const read = documentsIn('src/lib/prose.ts', source);
	assert.deepEqual(read.malformed, []);
	assert.deepEqual(read.unresolved, []);
	// Paired: the file's ACTUAL document is still found, so the silence above is
	// discrimination rather than blindness.
	assert.equal(read.documents.length, 1);
	assert.equal(read.documents[0].name, 'REAL');
});

test('a document forwarded through a private helper is still read', () => {
	// `cms/compose.ts` and `cms/review-transport.ts` both funnel writes through a
	// helper that takes the document as a parameter, so the `graphqlRequest` call
	// site has nothing to fold. The wrapper is DERIVED as a channel and its callers
	// followed; without that, four real documents would be reported as unreadable
	// and the gate would have to be loosened to ship.
	withTree(
		{
			entrySource: `import { create } from './lib/forward.ts';\ncreate();\n`,
			files: {
				'src/lib/forward.ts': `
import { graphqlRequest } from './cms/graphql.ts';

const CREATE = \`
	mutation Synthetic { articles { id } }
\`;

async function authenticatedWrite(document, variables) {
	return graphqlRequest(document, variables);
}

export async function create() {
	return authenticatedWrite(CREATE, {});
}
`,
			},
		},
		(root) => {
			const result = runGate(root, ['--inventory']);
			assert.equal(result.status, 0, result.out);
			assert.match(result.out, /Synthetic|authenticatedWrite/);
		}
	);
});

test('a wrapper EXPORTED across files is a channel too, and its callers are checked', () => {
	// The old reader gave up here — an exported helper's callers are in files it
	// "was not handed" — and reported the site unresolved. The graph is global now,
	// so the caller in another module is the site that carries the document.
	withTree(
		{
			entrySource: `import { post } from './lib/caller.ts';\npost();\n`,
			files: {
				'src/lib/wrap.ts': `
import { graphqlRequest } from './cms/graphql.ts';
export async function send(document, variables) {
	return graphqlRequest(document, variables);
}
`,
				'src/lib/caller.ts': `
import { send } from './wrap.ts';
export async function post() {
	return send(\`query SyntheticExported { articles { nope } }\`, {});
}
`,
			},
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "nope"/);
		}
	);
});

test('a branch-selected document contributes BOTH arms', () => {
	// `cms/loaders.ts` writes `const query = kind === 'series' ? A : B` and then
	// sends `query`. Folding that to a single value is impossible and folding it
	// to nothing loses two real documents; both are sent, so both are validated.
	withTree(
		{
			entrySource: `import { load } from './lib/branch.ts';\nload('series');\n`,
			files: {
				'src/lib/branch.ts': `
import { graphqlRequest } from './cms/graphql.ts';
const A = \`query SyntheticA { articles { id } }\`;
const B = \`query SyntheticB { articles { missingOnPurpose } }\`;

export async function load(kind) {
	const query = kind === 'series' ? A : B;
	return graphqlRequest(query, {});
}
`,
			},
		},
		(root) => {
			// The SECOND arm is the one with the defect: if only one arm were
			// followed, this would pass and the test would prove nothing.
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "missingOnPurpose"/);
		}
	);
});

test('every transport root really is an export of the module it names', () => {
	// The roots are the one place a document could reach lesser unchecked: a root
	// naming a module or export that no longer exists matches nothing, and matching
	// nothing looks exactly like finding nothing wrong. Measured, not trusted.
	assert.ok(TRANSPORT_ROOTS.length >= 2);
	for (const root of TRANSPORT_ROOTS) {
		const source = liveScript(root.module, readFileSync(join(REPO, root.module), 'utf8'));
		const exported = new Set();
		for (const match of source.matchAll(
			/export\s+(?:async\s+)?function\s+([A-Za-z_][\w]*)|export\s+const\s+([A-Za-z_][\w]*)/g
		)) {
			exported.add(match[1] ?? match[2]);
		}
		assert.ok(
			exported.has(root.export),
			`${root.module} must still export ${root.export}; the transport graph is rooted there`
		);
		assert.ok(
			typeof root.argument === 'number' || typeof root.property === 'string',
			'a root must name the slot its document arrives in'
		);
	}
});

/* =========================================================================
 * The four bypasses the adversarial review demonstrated
 *
 * Each one sends a document the old name-matching reader never saw. The document
 * is INVALID against the schema in every case, so a gate that finds it must fail
 * and a gate that misses it passes — there is no third outcome, and no assertion
 * about wording standing in for the bite.
 * ====================================================================== */

const BAD_DOCUMENT = '`query SyntheticBypass { articles { notAField } }`';

function bypassTree(moduleSource) {
	return {
		entrySource: `import { go } from './lib/bypass.ts';\ngo();\n`,
		files: { 'src/lib/bypass.ts': moduleSource },
	};
}

test('BYPASS 1 — an imported alias is still the transport', () => {
	withTree(
		bypassTree(`
import { graphqlRequest as send } from './cms/graphql.ts';
export async function go() {
	return send(${BAD_DOCUMENT}, {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('BYPASS 2 — a variable alias is still the transport', () => {
	withTree(
		bypassTree(`
import { graphqlRequest } from './cms/graphql.ts';
const send = graphqlRequest;
export async function go() {
	return send(${BAD_DOCUMENT}, {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('BYPASS 3 — a bracket property on a namespace is still the transport', () => {
	withTree(
		bypassTree(`
import * as transport from './cms/graphql.ts';
export async function go() {
	return transport['graphqlRequest'](${BAD_DOCUMENT}, {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('BYPASS 4 — a subscribe alias is still the transport', () => {
	withTree(
		bypassTree(`
import { subscribe as open } from '../lib/timelines/subscription.ts';
export function go() {
	return open({ query: ${BAD_DOCUMENT}, onData() {} });
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('BYPASS 5 — an alias of an alias, through a re-export barrel', () => {
	withTree(
		{
			entrySource: `import { go } from './lib/bypass.ts';\ngo();\n`,
			files: {
				'src/lib/barrel.ts': `export { graphqlRequest as relay } from './cms/graphql.ts';`,
				'src/lib/bypass.ts': `
import { relay } from './barrel.ts';
const again = relay;
export async function go() {
	return again(${BAD_DOCUMENT}, {});
}
`,
			},
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('BYPASS 6 — `export * from` carries the channel out too', () => {
	withTree(
		{
			entrySource: `import { go } from './lib/bypass.ts';\ngo();\n`,
			files: {
				'src/lib/star.ts': `export * from './cms/graphql.ts';`,
				'src/lib/bypass.ts': `
import { graphqlRequest } from './star.ts';
export async function go() {
	return graphqlRequest(${BAD_DOCUMENT}, {});
}
`,
			},
		},
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('BYPASS 7 — destructuring a namespace binds the channel', () => {
	withTree(
		bypassTree(`
import * as transport from './cms/graphql.ts';
const { graphqlRequest: fire } = transport;
export async function go() {
	return fire(${BAD_DOCUMENT}, {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /Cannot query field "notAField"/);
		}
	);
});

test('a dynamically assembled document reaching a channel FAILS CLOSED', () => {
	// The review's probes used exactly this: an anonymous operation built from
	// pieces, so no keyword survives in the literal chunks and pass 2's shape
	// screen cannot see it. Provenance still can — and, unable to fold it, must
	// report rather than shrug.
	withTree(
		bypassTree(`
import { graphqlRequest as send } from './cms/graphql.ts';
const parts = ['{ articles', ' { id } }'];
export async function go() {
	return send(parts.join(''), {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /could not determine what GraphQL text this sends/);
		}
	);
});

test('a transport selected by a COMPUTED key fails closed', () => {
	withTree(
		bypassTree(`
import * as transport from './cms/graphql.ts';
export async function go(pick) {
	return transport[pick](${BAD_DOCUMENT}, {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /computed key|undecidable channel/i);
		}
	);
});

test('a transport used as a VALUE rather than called fails closed', () => {
	withTree(
		bypassTree(`
import { graphqlRequest } from './cms/graphql.ts';
const registry = [];
export function go() {
	registry.push(graphqlRequest);
	return registry;
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /used as a value rather than called/);
		}
	);
});

test('a call merely SPELLED like a transport, with an unfollowable receiver, fails closed', () => {
	// The name-keyed backstop. Provenance says nothing about `getTransport()`, and
	// silence would be permission.
	withTree(
		bypassTree(`
function getTransport() { return globalThis.someTransport; }
export async function go() {
	return getTransport().graphqlRequest(${BAD_DOCUMENT}, {});
}
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 1, result.out);
			assert.match(result.out, /receiver not resolved to a transport/);
		}
	);
});

test('the backstop does NOT fire on an unrelated `subscribe` — precision is part of the control', () => {
	// This repository has store and push-manager `subscribe` methods. A backstop
	// keyed on the name alone would be dozens of findings about something else,
	// whose only repair is a disclosure — which is how a gate stops being read.
	withTree(
		bypassTree(`
const store = { subscribe(callback) { return () => callback; } };
export function go() {
	const stop = store.subscribe(() => {});
	return pushManagerLike.subscribe({ userVisibleOnly: true, applicationServerKey: 'k' }) && stop;
}
const pushManagerLike = { subscribe: (options) => options };
`),
		(root) => {
			const result = runGate(root);
			assert.equal(result.status, 0, result.out);
		}
	);
});

/* =========================================================================
 * The real build
 * ====================================================================== */

test('the REAL build loads nothing the static closure missed, and no disclosed vendored document', async () => {
	// THE COMPLEMENTARY READING, and the one that stops the boundary being an
	// argument about a parser. The gate's closure is static; this runs the actual
	// two-pass Vite build and asks what it LOADED. Two directions, both required:
	//
	//   (a) every module the build loaded is inside the static closure — so the
	//       static walk is not missing edges the build has. A miss there is exactly
	//       the `.js`→`.ts` defect the review demonstrated, and it would be silent.
	//   (b) no module the disclosure names as carrying an upstream document is
	//       loaded by either pass — so the exclusion is safe against what runs,
	//       not merely against what this repository's reader believes runs.
	//
	// The gate's OWN functions compute the closure here. A test that reimplemented
	// the walk would be comparing two of its own opinions, which is the shape of
	// the defect this whole milestone is about.
	const { sink } = await auditSeamGraph({ root: REPO });

	const loaded = new Set();
	for (const pass of sink.reached.keys()) {
		for (const id of sink.reached.get(pass).loaded) {
			// A file is not a module: `X.svelte` and `X.svelte?raw` are separate
			// modules. The boundary question is about the FILE, so the query goes.
			loaded.add(id.split(/[?#]/)[0]);
		}
	}
	assert.ok(loaded.size > 100, `the build must actually have loaded modules, saw ${loaded.size}`);

	const pin = JSON.parse(readFileSync(join(REPO, 'contracts/lesser/provenance.json'), 'utf8'));
	const entries = pin.build_entry_points.paths;

	const resolver = await createViteResolver({
		root: REPO,
		configFile: join(REPO, 'vite.config.ts'),
	});
	let closure;
	try {
		closure = await resolveClosure(REPO, entries, resolver);
	} finally {
		await resolver.close();
	}
	const { seen: reachable } = reachableFrom(entries, closure, resolverOver(closure));

	// (a) — no edge the build has that the static walk lacks. Scoped to files IN
	// THIS REPOSITORY: the closure classifies node_modules as external on purpose,
	// because a document assembled inside an npm package is not a document this
	// repository declares, and the vendored boundary is about `src/lib/greater/`.
	const missed = [...loaded].filter(
		(file) => isScript(file) && !file.startsWith('node_modules/') && !reachable.has(file)
	);
	assert.deepEqual(
		missed,
		[],
		'the real build loaded modules the static closure never reached — the boundary is blind along those edges'
	);

	// (b) — and nothing the disclosure excludes is loaded.
	for (const tree of pin.upstream_trees) {
		for (const document of Object.keys(tree.documents)) {
			assert.ok(
				!loaded.has(document),
				`${document} carries a disclosed upstream document and the real build LOADS it; ` +
					'a module the build loads is a module that can execute'
			);
		}
	}
});

test('the repository’s own tree passes the gate at its current bytes', () => {
	const result = runGate(REPO);
	assert.equal(result.status, 0, result.out);
	assert.match(result.out, /graphql-contract: PASS/);
	// The inventory is part of the evidence: a gate reporting PASS over zero
	// documents is the failure this whole file is written against.
	assert.match(result.out, /(\d+) contentus documents in \d+ modules/);
	const count = Number(result.out.match(/(\d+) contentus documents/)[1]);
	assert.ok(count >= 90, `expected the full document inventory, found ${count}`);
});
