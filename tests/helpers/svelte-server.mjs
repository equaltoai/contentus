/**
 * Render a real component to HTML under `node --test`.
 *
 * WHY THIS EXISTS. Face 6's behavioural tests — trust copy, capability lists,
 * the roster's cards and empty states — were asserted against the built SSR
 * handler with GraphQL stubbed. The agents surface became a session read
 * (lesser's gateway refuses anonymous `agents`/`agent` operations before the
 * resolver runs), the handler no longer fetches, and those tests lost the
 * render they were reading. The assertions were never about the handler: they
 * are about what the COMPONENTS paint for a given lesser answer, and this
 * helper renders exactly that — the real component tree, compiled for the
 * server by the real compiler, with no GraphQL and no DOM anywhere in it.
 *
 * `svelte/server`'s `render` runs no effects and no `onMount`, which is the
 * correct semantics for what these tests assert: the first-paint document for
 * the props given.
 *
 * Usage: `renderComponent('src/lib/agents/AgentDetail.svelte', { agent })` —
 * the specifier is repo-root-relative.
 */
import { register } from 'node:module';

let registered = false;

function ensureHooks() {
	if (registered) return;
	registered = true;
	register('./svelte-server-hooks.mjs', import.meta.url);
}

/**
 * Render one component to its HTML string. `specifier` is repo-root-relative
 * (`src/lib/agents/AgentDetail.svelte`); `props` are passed as the
 * component's props.
 */
export async function renderComponent(specifier, props = {}) {
	ensureHooks();
	const module = await import(new URL(`../../${specifier}`, import.meta.url).href);
	const { render } = await import('svelte/server');
	return render(module.default, { props }).html;
}
