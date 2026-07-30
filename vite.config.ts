import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

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
		plugins: [svelte()],
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
