import { hydrate, mount } from 'svelte';

import App from './App.svelte';
import type { RouteProps } from './types';

/**
 * Client entry.
 *
 * Under strict CSP the render data is not in the document, so hydration starts
 * by fetching it from the same-origin JSON endpoint the server advertised via
 * `<link rel="facetheory-hydration">`. Both the request URL and the response
 * URL are checked for same-origin: a redirect to another origin would
 * otherwise be followed and its JSON trusted as our render data.
 */

function readHydrationDataUrl(doc: Document): string | null {
	const byId = doc.getElementById('__FACETHEORY_DATA_URL__');
	if (byId?.tagName.toLowerCase() === 'link') {
		const href = byId.getAttribute('href');
		if (href) return href;
	}
	return doc.querySelector('link[rel="facetheory-hydration"]')?.getAttribute('href') ?? null;
}

function resolveHydrationDataUrl(doc: Document): URL | null {
	const href = readHydrationDataUrl(doc);
	if (!href) return null;

	const win = doc.defaultView ?? window;
	const dataUrl = new URL(href, win.location.href);
	if (dataUrl.origin !== win.location.origin) {
		throw new Error('FaceTheory hydration data must be same-origin.');
	}
	return dataUrl;
}

async function loadHydrationProps(doc: Document): Promise<RouteProps | null> {
	const dataUrl = resolveHydrationDataUrl(doc);
	if (!dataUrl) return null;

	const response = await fetch(dataUrl.toString(), {
		credentials: 'same-origin',
		headers: { accept: 'application/json' },
	});

	const responseUrl = response.url ? new URL(response.url, window.location.href) : dataUrl;
	if (responseUrl.origin !== window.location.origin) {
		throw new Error('FaceTheory hydration data response must remain same-origin.');
	}
	if (!response.ok) {
		throw new Error(`FaceTheory hydration data failed (${response.status}).`);
	}

	return (await response.json()) as RouteProps;
}

async function hydrateApp() {
	const props = await loadHydrationProps(document);
	if (!props) {
		throw new Error('FaceTheory hydration data was not advertised by the document.');
	}

	// `#app` exists only under `vite dev`; the installed build hydrates the
	// server-rendered body in place.
	const devTarget = document.getElementById('app');
	if (devTarget) {
		mount(App, { target: devTarget, props });
		return;
	}

	hydrate(App, { target: document.body, props });
}

void hydrateApp().catch((error) => {
	console.error('Contentus strict-CSP hydration failed', error);
});
