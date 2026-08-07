import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vendored greater modules that must go through Svelte's module compiler.
 *
 * vite-plugin-svelte compiles runes in plain modules only when the filename
 * carries the `.svelte.` infix. At greater-v0.11.9 the blog face's Article
 * context is `components/Article/context.ts` — no infix — and it calls
 * `$state(...)`. Nothing compiles it, so `$state` survives verbatim into the
 * bundle and the article reader dies at runtime with `ReferenceError: $state is
 * not defined` the first time an article actually loads. `pnpm dev` hides it:
 * Vite's dev SSR resolves the rune through Svelte's runtime import graph, and
 * the built artifact does not.
 *
 * The fix is the plugin's own supported hook — `experimental.compileModule.include`
 * — pointed at the vendored tree, so the vendored source stays byte-identical
 * and checksummed. Scoped to the whole tree rather than the one offending file
 * on purpose: a `greater` CLI pin bump that adds another rune-bearing module
 * under a plain name should keep working, not reintroduce a runtime crash.
 *
 * `tests/vendored-runes.test.mjs` keeps this honest, and the naming defect is
 * reported upstream — the file wants to be `context.svelte.ts`.
 */
const VENDORED_GREATER_MODULES = /\/src\/lib\/greater\/.*\.(?:js|ts)(?:[?#]|$)/;

/**
 * Two-pass build, matching the proven simulacrum skeleton:
 *
 *   pass 1 (client) → build/client, assets served from /l/_assets/
 *   pass 2 (ssr)    → build/server/handler.mjs, imported in-process by
 *                     lesser's SSR host
 *
 * `assetsInlineLimit: 0` is a CSP requirement, not a size preference: any
 * inlined asset becomes a `data:` URL in the document, which a strict policy
 * has to allow for. Keeping every asset external means the policy never needs
 * a `data:` source.
 */
export default defineConfig(({ command, isSsrBuild }) => {
	const ssr = Boolean(isSsrBuild);

	return {
		appType: ssr ? 'custom' : 'spa',
		base: !ssr && command === 'build' ? '/l/_assets/' : '/',
		plugins: [
			svelte({
				experimental: { compileModule: { include: [VENDORED_GREATER_MODULES] } },
			}),
		],
		resolve: {
			alias: [
				// The `greater` CLI emits vendored imports as bare specifiers built from
				// the components.json alias TARGET rather than an alias-prefixed path —
				// `import { sanitizeHtml } from 'src/lib/greater/utils'` appears in 65
				// vendored files at greater-v0.11.9. Bare `src/...` is not resolvable by
				// Node or Vite. Vendored source is never hand-edited, so the host absorbs
				// it here. Routed upstream to greater-components; remove when the CLI
				// emits relative or alias-prefixed paths.
				{ find: /^src\//, replacement: `${path.resolve(root, 'src')}/` },
				// Markdown-conversion modules contentus deliberately does not ship.
				// A dormant vendored module (`greater/utils/html-to-markdown.ts`)
				// imports them via the same barrel that exports `sanitizeHtml`, and
				// the bundler resolves the whole graph before tree-shaking drops the
				// dead branch. Aliased to a throwing stub rather than installing a
				// Markdown renderer, because rendering authority is lesser's.
				// See src/lib/build/absent-renderer-module.ts.
				...['hast-util-to-mdast', 'mdast-util-to-markdown', 'mdast-util-gfm'].map((name) => ({
					find: name,
					replacement: path.resolve(root, 'src/lib/build/absent-renderer-module.ts'),
				})),
				{ find: '$lib', replacement: path.resolve(root, 'src/lib') },
				{
					find: '$app/environment',
					replacement: path.resolve(root, 'src/facetheory/shims/app-environment.ts'),
				},
				{
					find: '$app/paths',
					replacement: path.resolve(root, 'src/facetheory/shims/app-paths.ts'),
				},
			],
		},
		ssr: {
			noExternal: true,
		},
		build: {
			outDir: ssr ? 'build/server' : 'build/client',
			emptyOutDir: !ssr,
			assetsInlineLimit: 0,
			manifest: ssr ? false : '.vite/manifest.json',
			ssr: ssr ? path.resolve(root, 'src/facetheory/entry-server.ts') : false,
			rollupOptions: {
				input: ssr
					? path.resolve(root, 'src/facetheory/entry-server.ts')
					: path.resolve(root, 'src/facetheory/entry-client.ts'),
				output: ssr
					? {
							format: 'esm',
							entryFileNames: 'handler.mjs',
							chunkFileNames: 'chunks/[name]-[hash].mjs',
							assetFileNames: 'assets/[name]-[hash][extname]',
							// The handler must be ONE self-contained module. FaceTheory
							// dynamically imports `svelte/server`, which Rollup factors into
							// a shared chunk that statically re-exports from the entry —
							// a circular edge (entry → chunk → entry). lesser's SSR host
							// imports the entry as `handler.mjs?install=<id>` to scope the
							// module cache, and the query makes Node instantiate the entry
							// TWICE: the chunk's bare `../handler.mjs` resolves to a second,
							// query-less copy. Svelte's SSR context (`ssr_context`) is a
							// module global, so the render runtime (no-query instance) and
							// the component code (queried instance) read different
							// `ssr_context` values and every `getContext`/`setContext`
							// throws `lifecycle_outside_component` — a 500 on exactly the
							// routes whose components use context. Inlining the dynamic
							// import removes the cross-file edge, so a query-suffixed
							// import can only ever produce one instance.
							codeSplitting: false,
						}
					: {
							entryFileNames: 'assets/[name]-[hash].js',
							chunkFileNames: 'assets/[name]-[hash].js',
							assetFileNames: 'assets/[name]-[hash][extname]',
						},
			},
		},
	};
});
