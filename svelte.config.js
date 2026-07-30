import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Contentus renders under a strict CSP with no inline <style>. Svelte's
		// scoped styles are extracted to the external stylesheet by Vite; this
		// flag keeps runtime-injected CSS off the table entirely.
		css: 'external',
	},
};
