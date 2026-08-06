/**
 * Module resolution, done by the resolver that actually runs.
 *
 * WHY NOT A TABLE OF EXTENSIONS. This gate used to resolve specifiers with a
 * hand-written candidate list — the specifier, then `+ '.ts'`, `+ '.js'`, then
 * `/index.<ext>` — and called the result an over-approximation of what the build
 * loads. It was not an over-approximation; it was a DIFFERENT function, and the
 * adversarial review found the gap in production source. `src/lib/routes/
 * ArticleReader.svelte` imports `$lib/greater/faces/blog/components/Article/
 * index.js`, and the file on disk is `index.ts`. Vite resolves that — TypeScript
 * source is written with `.js` specifiers and every bundler maps them back — while
 * the candidate list tested `index.js`, then `index.js.ts`, and answered `null`.
 *
 * An edge the walk cannot see is an edge the boundary check cannot forbid, and
 * that boundary is the only thing making the vendored-tree exclusion safe. So a
 * miss there does not degrade the gate's precision; it removes the control. The
 * review demonstrated exactly that: an outside module importing a document-bearing
 * vendored `adapter.ts` failed the gate as required, and changing only the
 * specifier to `adapter.js` — same file on disk — made it PASS.
 *
 * WHAT THIS DOES INSTEAD. It asks Vite. `createServer` in middleware mode gives a
 * plugin container whose `resolveId` is the same code path the build uses, with
 * this repository's real config: the `$lib` and `$app/*` aliases, the bare `src/`
 * alias the `greater` CLI emits, the markdown stubs, the svelte plugin's
 * extensions, TypeScript's `.js`→`.ts` mapping, directory barrels, and query
 * suffixes. Nothing here restates any of it, so nothing here can drift from it.
 * It costs ~300ms once and ~0.2ms per specifier.
 *
 * BOTH ENVIRONMENTS, UNIONED. Vite resolves per environment, and the client and
 * ssr passes can answer differently. For "can anything outside the vendored tree
 * reach a document-bearing module inside it?" the union is the safe direction: a
 * module either pass can load is a module that can execute. Where the two
 * environments resolve one specifier to two different files, that is reported
 * rather than silently collapsed — a caller folding an imported constant has to
 * pick one file, and picking without saying so is how a reading starts describing
 * a module that never runs.
 *
 * THREE OUTCOMES, AND `unresolved` IS NOT `external`. A specifier reaching a real
 * file inside the tree is an edge to follow; one reaching node_modules or a
 * virtual module is outside this repository's contract surface; one Vite cannot
 * resolve at all is a load whose target is unknown, and the caller must treat it
 * as a finding. Collapsing the third into the second is the fail-open this module
 * exists to remove.
 */
import path from 'node:path';

/** A resolved id's file part, with any `?query` / `#hash` suffix split off. */
function splitQuery(id) {
	const cut = id.search(/[?#]/);
	if (cut === -1) return { file: id, query: '' };
	return { file: id.slice(0, cut), query: id.slice(cut) };
}

/**
 * Classify a resolved id against the tree.
 *
 * A `\0`-prefixed id is a plugin's virtual module and names no file. Anything
 * under `node_modules`, or outside the root, is external: a document assembled
 * inside an npm package is not a document this repository declares.
 */
function classify(id, root) {
	if (!id || typeof id !== 'string') return { kind: 'unresolved' };
	if (id.startsWith('\0')) return { kind: 'external', reason: 'virtual module' };

	const { file, query } = splitQuery(id);
	// A resolver may answer with an id that is not a path at all — `node:fs/promises`,
	// `__vite-browser-external:node:fs/promises`. Resolving those against the cwd
	// would invent a file inside the tree and, worse, make the two environments
	// look like they disagreed about a real module.
	if (!path.isAbsolute(file)) return { kind: 'external', reason: 'non-path module id' };

	const absolute = path.resolve(file);
	const relative = path.relative(root, absolute);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return { kind: 'external', reason: 'outside the repository root' };
	}
	if (relative.split(path.sep).includes('node_modules')) {
		return { kind: 'external', reason: 'node_modules' };
	}
	return { kind: 'file', file: relative.split(path.sep).join('/'), query };
}

/**
 * A resolver backed by a real Vite server for `root`.
 *
 * `configFile` defaults to whichever Vite config the tree has; a tree without one
 * gets Vite's defaults, which is the honest answer for a synthetic repository
 * that declares no aliases.
 */
export async function createViteResolver({ root, configFile, plugins }) {
	const { createServer } = await import('vite');

	const server = await createServer({
		root,
		configFile: configFile ?? false,
		...(plugins ? { plugins } : {}),
		logLevel: 'silent',
		appType: 'custom',
		server: { middlewareMode: true, watch: null, hmr: false },
		// Nothing here executes or bundles; pre-bundling would only add startup
		// cost and a cache directory this gate has no use for.
		optimizeDeps: { noDiscovery: true, include: [] },
	});

	const environments = ['ssr', 'client']
		.map((name) => server.environments?.[name])
		.filter((environment) => environment?.pluginContainer);

	if (!environments.length) {
		await server.close();
		throw new Error('vite resolver: no environment exposed a plugin container');
	}

	const cache = new Map();

	// The alias table Vite actually resolved, read rather than restated. It is what
	// decides whether a BARE specifier could name a file in this tree at all: this
	// repository aliases `src/…` into the source tree and three markdown packages
	// onto a local stub, so "bare" is not a synonym for "external" here.
	const aliases = Array.isArray(server.config?.resolve?.alias)
		? server.config.resolve.alias
		: Object.entries(server.config?.resolve?.alias ?? {}).map(([find, replacement]) => ({
				find,
				replacement,
			}));

	/**
	 * Could this specifier name a file inside the tree?
	 *
	 * Relative and rooted specifiers always could. A bare one could only through an
	 * alias, so the real alias table answers it. The distinction matters where an
	 * unresolvable load is concerned: `import '@apollo/client'` in dormant vendored
	 * source names a package this repository does not install and CANNOT name a
	 * file in `src/lib/greater/`, while an unresolvable `./adapter` or `$lib/…`
	 * genuinely leaves the closure blind.
	 */
	const namesAPath = (specifier) => {
		if (specifier.startsWith('.') || specifier.startsWith('/')) return true;
		return aliases.some(({ find }) => {
			if (find instanceof RegExp) return find.test(specifier);
			if (typeof find !== 'string') return false;
			return specifier === find || specifier.startsWith(`${find}/`);
		});
	};

	/**
	 * Resolve one specifier from one importer.
	 *
	 * Returns `{ outcomes, files, unresolved, divergent }` — `outcomes` is one
	 * entry per environment, `files` the deduped set of in-tree targets.
	 */
	async function resolve(specifier, fromFile) {
		const key = `${fromFile}\0${specifier}`;
		const cached = cache.get(key);
		if (cached) return cached;

		const importer = path.resolve(root, fromFile);
		const outcomes = [];
		for (const environment of environments) {
			let resolved = null;
			try {
				resolved = await environment.pluginContainer.resolveId(specifier, importer);
			} catch {
				// A plugin throwing on a specifier is not a resolution; it is an
				// answer this reader does not have, and it must not read as absence.
				outcomes.push({ environment: environment.name, kind: 'unresolved' });
				continue;
			}
			const id = typeof resolved === 'string' ? resolved : resolved?.id;
			outcomes.push({ environment: environment.name, ...classify(id, root) });
		}

		const files = [...new Set(outcomes.filter((o) => o.kind === 'file').map((o) => o.file))];
		const answer = {
			specifier,
			from: fromFile,
			outcomes,
			files,
			query: outcomes.find((o) => o.kind === 'file')?.query ?? '',
			// Unresolved only when NO environment could name a target. One pass
			// resolving and the other not is normal (conditions differ); neither
			// resolving is a load whose target is unknown.
			unresolved: outcomes.every((o) => o.kind === 'unresolved'),
			external: files.length === 0 && outcomes.some((o) => o.kind === 'external'),
			divergent: files.length > 1,
			// Whether an unresolved answer is a hole in the closure or simply a
			// package this repository does not install.
			namesAPath: namesAPath(specifier),
		};
		cache.set(key, answer);
		return answer;
	}

	return {
		resolve,
		environments: environments.map((environment) => environment.name),
		close: () => server.close(),
	};
}
