import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSiteStylesheet } from '../scripts/build-stylesheet.mjs';
import { AUDIT_ROUTES, loadHandler, renderRoute } from '../scripts/render-routes.mjs';

/**
 * Mobile chrome probes (M3.1, M3.5).
 *
 * WHAT AN SSR PROBE CAN AND CANNOT SAY ABOUT A BREAKPOINT. The server renders
 * one document for every viewport — it has no width to branch on, and that is
 * deliberate: lesser performs no SPA fallback under `/l/*`, so a phone's first
 * paint is this document. So a breakpoint is proven in two halves, and both
 * halves are here:
 *
 *   1. THE MARKUP half. The chrome must be in the document that ships, on
 *      every route, without JavaScript. If the tab bar only appears after
 *      hydration, a phone on a slow connection gets a page with no navigation.
 *   2. THE STYLESHEET half. The rules that respond at 960/720/640/480 must be
 *      in the one stylesheet the document links, and they must carry the
 *      properties the design names — 44px targets, `100svh`, the safe-area
 *      inset.
 *
 * What no probe here claims is that the layout LOOKS right at 375px. That is
 * the instance-validation step on a real phone viewport (M3.6), and these
 * assertions are what make that step a check rather than a discovery.
 */

const handler = await loadHandler();
const stylesheet = buildSiteStylesheet();

/** The stylesheet text inside `@media (max-width: <px>)`, blocks concatenated. */
function mediaBlocks(css, maxWidth) {
	const marker = `@media (max-width: ${maxWidth}px)`;
	const blocks = [];

	let index = css.indexOf(marker);
	while (index !== -1) {
		const open = css.indexOf('{', index);
		if (open === -1) break;

		let depth = 0;
		let end = open;
		for (; end < css.length; end += 1) {
			if (css[end] === '{') depth += 1;
			else if (css[end] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}

		blocks.push(css.slice(open + 1, end));
		index = css.indexOf(marker, end);
	}

	return blocks.join('\n');
}

test('every route ships the mobile chrome in its server-rendered document', async () => {
	// Not one route: all of them. The tab bar is the mobile navigation, so a
	// route that renders without it is a dead end on a phone.
	for (const route of AUDIT_ROUTES) {
		if (route.name === 'hydration-data') continue;

		const rendered = await renderRoute(handler, route);
		assert.equal(rendered.status, route.expectStatus, `${route.name} status`);
		assert.match(
			rendered.html,
			/class="contentus-tabbar"/,
			`${route.name} must server-render the bottom tab bar`
		);
		assert.match(
			rendered.html,
			/class="contentus-fab"/,
			`${route.name} must server-render the compose FAB`
		);
	}
});

test('the FAB points at /compose rather than being a decoration', async () => {
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	assert.match(
		rendered.html,
		/<a class="contentus-fab" href="\/l\/compose"/,
		'the FAB must be a real link to the composer route'
	);
});

test('every route carries the viewport meta the chrome depends on', async () => {
	for (const route of AUDIT_ROUTES) {
		if (route.name === 'hydration-data') continue;

		const rendered = await renderRoute(handler, route);
		assert.match(
			rendered.html,
			/name="viewport"[^>]*content="width=device-width, initial-scale=1"|content="width=device-width, initial-scale=1"[^>]*name="viewport"/,
			`${route.name} must declare the viewport`
		);
	}
});

test('no tab depends on hover to say what it is', async () => {
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	// Every tab carries a permanent text label beside its icon. A phone has no
	// hover, so an icon whose meaning arrives on hover has no meaning at all.
	const labels = rendered.html.match(/class="contentus-tabbar__label">([^<]+)</g) ?? [];
	assert.ok(labels.length >= 3, 'each rendered tab must carry a visible text label');

	// And the current tab is marked structurally, not by colour alone.
	assert.match(rendered.html, /class="contentus-tabbar__tab" href="\/l\/" aria-current="page"/);
});

test('an unshipped face is a disabled tab, never a link that would 404', async () => {
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	// lesser has no SPA fallback under /l/*, so an href to a route that does not
	// exist is a hard error page rather than a soft miss.
	assert.match(rendered.html, /<span class="contentus-tabbar__tab" aria-disabled="true">/);
	assert.doesNotMatch(rendered.html, /class="contentus-tabbar__tab" href="\/l\/timelines"/);
	assert.doesNotMatch(rendered.html, /class="contentus-tabbar__tab" href="\/l\/agents"/);
});

test('the anonymous server render shows only anonymous tabs', async () => {
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	// Messages requires auth, and the server cannot know who is asking — the
	// session lives in sessionStorage. So the cacheable SSR document is the
	// anonymous bar, and Messages arrives on hydration.
	assert.doesNotMatch(rendered.html, /contentus-tabbar__label">Messages</);
	assert.match(rendered.html, /contentus-tabbar__label">Articles</);
});

test('the chrome responds at every breakpoint the design names', () => {
	for (const breakpoint of [960, 720, 640, 480]) {
		const block = mediaBlocks(stylesheet, breakpoint);
		assert.ok(
			block.length > 0,
			`the stylesheet must carry rules at the ${breakpoint}px breakpoint`
		);
		assert.match(
			block,
			/contentus-/,
			`the ${breakpoint}px breakpoint must govern contentus-owned chrome`
		);
	}
});

test('960px is where the sidebar nav hands over to the tab bar', () => {
	const block = mediaBlocks(stylesheet, 960);

	assert.match(block, /\.contentus-tabbar\s*\{[^}]*position:\s*fixed/);
	assert.match(block, /\.contentus-nav\s*\{[^}]*display:\s*none/);
	assert.match(block, /\.contentus-fab\s*\{[^}]*position:\s*fixed/);
});

test('touch targets never fall below 44px, at any breakpoint', () => {
	// The floor is a floor. 640px and 480px tighten labels and padding; if a
	// rule there ever set a height or min-height below 44px on a target, the
	// design's own minimum would have been traded for a few pixels of label.
	for (const breakpoint of [960, 720, 640, 480]) {
		const block = mediaBlocks(stylesheet, breakpoint);
		for (const match of block.matchAll(/min-height:\s*(\d+)px/g)) {
			const value = Number(match[1]);
			assert.ok(
				value >= 44,
				`a ${breakpoint}px rule sets min-height ${value}px, below the 44px minimum`
			);
		}
	}
});

test('the sheet is sized in svh and clears the safe area', () => {
	// 100vh measures the pre-scroll viewport, which puts a sticky action bar
	// behind the browser chrome exactly when the keyboard is up. And a bar that
	// ignores the safe-area inset sits under the home indicator.
	assert.match(stylesheet, /height:\s*100svh/);
	assert.match(stylesheet, /--contentus-safe-bottom:\s*env\(safe-area-inset-bottom/);

	const block = mediaBlocks(stylesheet, 960);
	assert.match(block, /padding-bottom:\s*calc\([\s\S]*?--contentus-safe-bottom/);
});

test('the composer sheet claims the viewport and gives back a way out', () => {
	const block = mediaBlocks(stylesheet, 960);

	// The sheet covers the tab bar rather than stacking two bars into the safe
	// area, so it has to own the exit.
	assert.match(block, /\[data-page='compose'\]\s*\.contentus-tabbar[^{]*\{[^}]*display:\s*none/s);
	assert.match(block, /\.contentus-compose-close\s*\{[^}]*min-height:\s*44px/s);
	assert.match(block, /\[data-page='compose'\]\s*\.contentus-main\s*\{[^}]*100svh/s);
});

test('the page identity the sheet keys off is in the document', async () => {
	const compose = await renderRoute(handler, {
		name: 'compose',
		path: '/l/compose',
		expectStatus: 200,
	});
	const index = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	// The breakpoint swap is CSS on an attribute the server emits, not a
	// viewport measured in JavaScript — so it is right in the first paint.
	assert.match(compose.html, /data-page="compose"/);
	assert.match(index.html, /data-page="articles-index"/);
});
