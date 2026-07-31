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
 * The finding this section exists for: the test above asserted only the
 * `.contentus-review-publish__*` pair — contentus's own controls. The VERDICT
 * controls are the vendored `Review.VerdictActions`, which renders every one of
 * its buttons at `size="sm"`, and the vendored primitives theme sizes that
 * variant `min-height: 2rem`. So the two decisions a reviewer makes were 32px
 * targets, on selectors no assertion here named, and the suite was green.
 *
 * The lesson is in the shape of these probes, not just their subject: a
 * stylesheet assertion is only worth its selector, so each one below reads the
 * class list out of the SHIPPED COMPONENT first and then requires the sheet to
 * size exactly that.
 * ------------------------------------------------------------------------ */

/** The first rule whose selector list names `.<className>`, with its body. */
function ruleNaming(css, className) {
	const marker = `.${className}`;
	const at = css.indexOf(marker);
	if (at === -1) return null;

	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	if (open === -1 || close === -1) return null;

	// Walk back to the start of the selector list so the whole list is visible.
	const selectorStart = Math.max(css.lastIndexOf('}', at), css.lastIndexOf('*/', at)) + 1;

	return {
		index: at,
		selector: css.slice(selectorStart, open).trim(),
		declarations: css.slice(open + 1, close),
	};
}

test('the verdict controls the component renders are the ones the stylesheet sizes', () => {
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

	// The vendored size the bridge exists to lift, confirmed rather than assumed:
	// if upstream ever raises `--sm` to the floor, this is the assertion that
	// says the bridge can go.
	assert.match(component, /size="sm"/, 'the vendored controls still render at the sm size');
	const smallVariant = ruleNaming(stylesheet, 'gr-button--sm');
	assert.ok(smallVariant, 'the vendored primitives theme must define the sm size variant');
	assert.match(smallVariant.declarations, /min-height:\s*2rem/);

	// And the sheet must raise each emitted selector to the floor.
	for (const className of emitted) {
		const rule = ruleNaming(stylesheet, className);
		assert.ok(rule, `the stylesheet must carry a rule naming .${className}`);
		assert.match(
			rule.declarations,
			/min-height:\s*44px/,
			`.${className} must meet the 44px touch floor`
		);
		assert.ok(
			rule.index > smallVariant.index,
			'the contentus sizing bridge must cascade after the vendored size variant'
		);
		// Descendant-qualified, so it wins on specificity rather than on order.
		assert.match(rule.selector, /\.gr-blog-review-verdict\s+\.gr-blog-review-verdict__approve/);
	}
});

test('the verdict confirmation dialog controls meet the same floor', () => {
	const component = readFileSync('src/lib/components/Review/VerdictActions.svelte', 'utf8');

	// The dialog is where the verdict is actually confirmed, and its Cancel and
	// confirm buttons are `size="sm"` too. The class the sheet hooks is the one
	// the component hands the Modal.
	assert.match(component, /class="gr-blog-review-verdict__dialog"/);

	const rule = ruleNaming(stylesheet, 'gr-blog-review-verdict__approve');
	assert.match(
		rule.selector,
		/\.gr-blog-review-verdict__dialog\s+\.gr-modal__footer\s+\.gr-button/,
		"the dialog's own buttons must be sized by the same rule"
	);
	assert.match(
		rule.selector,
		/\.gr-blog-review-verdict__dialog\s+\.gr-modal__close/,
		'and so must its close control'
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
