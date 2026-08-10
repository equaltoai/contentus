import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
 *
 * AND WHAT THE STYLESHEET HALF IS, EXACTLY: string parsing over the assembled
 * CSS. No viewport is emulated, no rule is cascaded, no `min-height` is
 * resolved against a box. A test that finds `min-height: 44px` inside an
 * `@media (max-width: 960px)` block has proven the declaration is in the
 * stylesheet that ships — not that the tab it belongs to renders 44 pixels
 * tall, which depends on specificity, inheritance, and a browser. Every test
 * below whose evidence is the stylesheet says "the stylesheet" in its name for
 * that reason, and the ones whose evidence is the document say "the document".
 *
 * A separate note, because the two get confused: this file says nothing about
 * inline style. `scripts/audit-csp.mjs` is what asserts the shipped documents
 * carry no inline `style=` and no inline `<style>`, against the built handler's
 * output, on every route.
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

test('every tab is either a link to a route that answers, or a disabled span', async () => {
	// THE RULE, rather than a list of which faces have shipped. This used to
	// enumerate the upcoming ones and shrink by one per milestone; M6 landed the
	// last upcoming tab in the bar, so an enumeration would now assert an empty
	// set and quietly stop checking anything. The invariant is what mattered all
	// along: lesser has no SPA fallback under `/l/*`, so a tab href pointing at a
	// route that does not exist is a hard error page, not a soft miss.
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	const tabs = [...rendered.html.matchAll(/<(a|span) class="contentus-tabbar__tab"([^>]*)>/g)];
	assert.ok(tabs.length >= 3, 'the bar must render its tabs');

	for (const [, element, attributes] of tabs) {
		if (element === 'span') {
			assert.match(attributes, /aria-disabled="true"/, 'an inert tab must say it is inert');
			continue;
		}

		const path = /href="([^"]+)"/.exec(attributes)?.[1];
		assert.ok(path, 'a link tab must carry an href');

		const target = await renderRoute(handler, { name: `tab:${path}`, path, expectStatus: 200 });
		assert.equal(target.status, 200, `${path} is linked from the tab bar and must answer`);
	}
});

test('a SHIPPED face is a real link, so the tab bar tracks what exists', async () => {
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	// The other half of the rule above, and the half that catches the opposite
	// mistake: a face whose route landed while its nav entry stayed `upcoming` is
	// a surface nobody can reach from the chrome. Agents joined this assertion
	// when M6 landed its route, the way Timelines did at M4.
	assert.match(rendered.html, /class="contentus-tabbar__tab" href="\/l\/timelines"/);
	assert.match(rendered.html, /class="contentus-tabbar__tab" href="\/l\/agents"/);
});

test('the anonymous server render shows only anonymous tabs', async () => {
	const rendered = await renderRoute(handler, { name: 'index', path: '/l/', expectStatus: 200 });

	// Messages requires auth, and the server cannot know who is asking — the
	// session lives in sessionStorage. So the cacheable SSR document is the
	// anonymous bar, and Messages arrives on hydration.
	assert.doesNotMatch(rendered.html, /contentus-tabbar__label">Messages</);
	assert.match(rendered.html, /contentus-tabbar__label">Articles</);
});

test('the stylesheet carries rules at every breakpoint the design names', () => {
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

test('the stylesheet hands the sidebar over to the tab bar at 960px', () => {
	const block = mediaBlocks(stylesheet, 960);

	assert.match(block, /\.contentus-tabbar\s*\{[^}]*position:\s*fixed/);
	assert.match(block, /\.contentus-nav\s*\{[^}]*display:\s*none/);
	assert.match(block, /\.contentus-fab\s*\{[^}]*position:\s*fixed/);
});

test('no breakpoint rule in the stylesheet sets a min-height below 44px', () => {
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

test('the stylesheet sizes the sheet in svh and clears the safe area', () => {
	// 100vh measures the pre-scroll viewport, which puts a sticky action bar
	// behind the browser chrome exactly when the keyboard is up. And a bar that
	// ignores the safe-area inset sits under the home indicator.
	assert.match(stylesheet, /height:\s*100svh/);
	assert.match(stylesheet, /--contentus-safe-bottom:\s*env\(safe-area-inset-bottom/);

	const block = mediaBlocks(stylesheet, 960);
	assert.match(block, /padding-bottom:\s*calc\([\s\S]*?--contentus-safe-bottom/);
});

test('the stylesheet gives the composer sheet the viewport, and a way out', () => {
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

/* ---------------------------------------------------------------------------
 * Face 2's single-column workspace (M2d.4)
 *
 * Same rule as the rest of this file: these assert what the STYLESHEET ships,
 * because CSS is only real once a browser resolves it against a box. What they
 * genuinely prove is that the declarations are there, in the right media
 * block, keyed off an attribute the server emits — which is the part that can
 * regress silently.
 * ------------------------------------------------------------------------ */

test('the stylesheet shows one workspace panel at a time below the breakpoint', () => {
	const block = mediaBlocks(stylesheet, 960);

	// The unselected panel is `display: none` — out of the accessibility tree
	// and out of the tab order — rather than merely painted over, so a screen
	// reader and a keyboard agree with what is on screen.
	assert.match(
		block,
		/\[data-panel='details'\]\s*\[data-review-panel='preview'\][\s\S]*?display:\s*none/,
		'the details panel must hide the preview'
	);
	assert.match(
		block,
		/\[data-panel='preview'\]\s*\[data-review-panel='details'\][\s\S]*?display:\s*none/,
		'the preview panel must hide the details'
	);

	// And never a split: the single column is the whole point.
	assert.match(block, /\.contentus-review-workspace\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('the rail keeps the attribution strip stacked at every viewport', () => {
	// The vendored DefinitionItem goes two-column (`minmax(0, 14rem) minmax(0,
	// 1fr)`) at 640px VIEWPORT width. Inside the 22rem rail that leaves the
	// value a character wide and it wraps a letter per line — on desktop. The
	// override therefore lives OUTSIDE any media block, and it must also reset
	// the vendored `grid-column` pins, which would otherwise open an implicit
	// second column against the single track.
	assert.match(
		stylesheet,
		/\.contentus-review-rail\s+\.gr-definition-item\s*\{[^}]*grid-template-columns:\s*1fr/s,
		'the rail must override the vendored two-column definition item'
	);
	assert.match(
		stylesheet,
		/\.contentus-review-rail\s+\.gr-definition-item__label,[\s\S]*?grid-column:\s*auto/s,
		'the rail must reset the vendored grid-column pins'
	);
});

test('the stylesheet hides the segmented control where there is nothing to switch', () => {
	// Above the breakpoint both panels are on screen, so the control is not in
	// the layout at all rather than being a no-op the reviewer can press.
	assert.match(stylesheet, /\.contentus-review-segmented\s*\{[^}]*display:\s*none/s);

	const block = mediaBlocks(stylesheet, 960);
	assert.match(block, /\.contentus-review-segmented\s*\{[^}]*display:\s*flex/s);
});

test('the stylesheet gives the segmented control 44px targets', () => {
	const block = mediaBlocks(stylesheet, 960);
	assert.match(block, /\.contentus-review-segmented__option\s*\{[^}]*min-height:\s*44px/s);
});

test('the stylesheet sticks the verdict and publish actions above the tab bar', () => {
	const block = mediaBlocks(stylesheet, 960);

	// A decision surface that scrolls away is one that gets made from memory.
	const actions = /\.contentus-review-actions\s*\{([^}]*)\}/s.exec(block)?.[1] ?? '';
	assert.match(actions, /position:\s*sticky/);

	// Above the tab bar AND the home indicator, not underneath either. Both
	// terms are asserted because dropping one is the regression: the bar lands
	// behind the tab bar, or behind the home indicator, and looks fine on the
	// simulator that has neither.
	assert.match(actions, /bottom:\s*calc\(/);
	assert.match(actions, /--contentus-tabbar-height/);
	assert.match(actions, /--contentus-safe-bottom/);

	// And the workspace leaves room, so the last line of a preview is readable
	// rather than permanently behind the bar.
	const workspace = /\.contentus-review-workspace\s*\{([^}]*)\}/s.exec(block)?.[1] ?? '';
	assert.match(workspace, /padding-bottom:\s*calc\(/);
	assert.match(workspace, /--contentus-tabbar-height/);
	assert.match(workspace, /--contentus-safe-bottom/);
});

test('the publish controls are 44px wherever they render', () => {
	// Not inside a media block: the floor applies on every viewport, because a
	// touch target that is only large on a phone is a target that got small on
	// a tablet.
	assert.match(
		stylesheet,
		/\.contentus-review-publish__primary,\s*\n?\s*\.contentus-review-publish__secondary\s*\{[^}]*min-height:\s*44px/s
	);
	assert.match(stylesheet, /\.contentus-review-field input\s*\{[^}]*min-height:\s*44px/s);
});

/* ---------------------------------------------------------------------------
 * The verdict controls, asserted on the selectors that actually render
 *
 * The finding this section exists for: an earlier suite asserted only the
 * `.contentus-review-publish__*` pair — contentus's own controls. The VERDICT
 * controls are the vendored `Review.VerdictActions`, which then rendered every
 * one of its buttons at `size="sm"` (32px), so the two decisions a reviewer
 * makes were sub-floor targets on selectors no assertion named. Contentus
 * carried a sizing bridge in `src/lib/brand/bridge.css` and these probes
 * pinned it — with the sunset written into both: when greater sizes its
 * verdict controls to the floor itself, the bridge and its assertions go.
 *
 * greater-v0.13.4 did exactly that (upstream #1018): every control the
 * component renders — the verdict pair, the dialog's Cancel and confirm, is
 * now `size="lg"`, and the vendored primitives theme sizes that variant
 * `min-height: 3rem` (48px), above the 44px floor on its own. The bridge is
 * deleted; what these probes pin now is the NATIVE floor, so a future
 * regression back below it fails here rather than shipping silently.
 * ------------------------------------------------------------------------ */

test('the verdict controls the component renders meet the touch floor natively', () => {
	const component = readFileSync('src/lib/components/Review/VerdictActions.svelte', 'utf8');

	// What ships. Read from the component so a renamed class breaks this test
	// rather than silently emptying it.
	const emitted = ['gr-blog-review-verdict__approve', 'gr-blog-review-verdict__request-changes'];
	for (const className of emitted) {
		assert.match(
			component,
			new RegExp(`class="${className}"`),
			`VerdictActions must emit .${className} — if it no longer does, this probe is asserting nothing`
		);
	}

	// The native size, confirmed rather than assumed: every control renders at
	// `size="lg"` (upstream #1018), never `size="sm"`.
	assert.match(component, /size="lg"/, 'the vendored controls must render at the lg size');
	assert.doesNotMatch(
		component,
		/size="sm"/,
		'a control back at size="sm" is a regression below the touch floor'
	);

	// And the vendored theme must size that variant at or above the floor.
	const marker = '.gr-button--lg';
	const at = stylesheet.indexOf(marker);
	assert.ok(at !== -1, 'the vendored primitives theme must define the lg size variant');
	const open = stylesheet.indexOf('{', at);
	const close = stylesheet.indexOf('}', open);
	const declarations = stylesheet.slice(open + 1, close);
	assert.match(
		declarations,
		/min-height:\s*3rem/,
		'the lg variant must meet the 44px touch floor (3rem = 48px)'
	);
});

test('the verdict confirmation dialog controls meet the same floor', () => {
	const component = readFileSync('src/lib/components/Review/VerdictActions.svelte', 'utf8');

	// The dialog is where the verdict is actually confirmed; its class is the
	// one the component hands the Modal.
	assert.match(component, /class="gr-blog-review-verdict__dialog"/);

	// Its Cancel and confirm buttons render at `size="lg"` like the verdict
	// pair (upstream #1018) — the floor holds inside the dialog too.
	assert.match(
		component,
		/variant="ghost" size="lg"[^>]*>Cancel<\/Button>/,
		'the dialog Cancel control must render at the lg size'
	);
	const lgCount = (component.match(/size="lg"/g) || []).length;
	assert.ok(
		lgCount >= 4,
		`expected at least four lg controls (verdict pair, Cancel, confirm); found ${lgCount}`
	);
});

test('the verdict floor holds at every mobile breakpoint, by never lifting', () => {
	// The floor is declared outside every media block, so the mobile breakpoints
	// inherit it rather than restating it. What could still go wrong is a
	// breakpoint rule LOWERING it, so that is what is checked: no rule at
	// 960/720/640/480 may touch a verdict selector with a smaller min-height.
	for (const breakpoint of [960, 720, 640, 480]) {
		const block = mediaBlocks(stylesheet, breakpoint);
		for (const match of block.matchAll(
			/(\.gr-blog-review-verdict[^{}]*)\{([^}]*min-height:\s*(\d+(?:\.\d+)?)(px|rem)[^}]*)\}/g
		)) {
			const value = match[4] === 'rem' ? Number(match[3]) * 16 : Number(match[3]);
			assert.ok(
				value >= 44,
				`a ${breakpoint}px rule sizes a verdict control at ${match[3]}${match[4]}, below the floor`
			);
		}
	}

	// And the vendored component is not edited to achieve any of this.
	const component = readFileSync('src/lib/components/Review/VerdictActions.svelte', 'utf8');
	assert.doesNotMatch(
		component,
		/min-height/,
		'the fix must not have been made in vendored source'
	);
});
