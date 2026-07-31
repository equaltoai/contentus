/**
 * Face 5's mobile collapse (product design §5, §4) — sub-issue #36.
 *
 * SAME EVIDENCE RULES AS `mobile-chrome.test.mjs`, restated because they are
 * what keeps these assertions honest. The STYLESHEET half is string parsing
 * over the assembled CSS: no viewport is emulated and no rule is cascaded, so
 * finding `min-height: 44px` proves the declaration ships, not that a control
 * renders 44 pixels tall. Every test whose evidence is the stylesheet says "the
 * stylesheet"; the ones whose evidence is the rendered document say "the
 * document".
 *
 * The DOCUMENT half drives the built handler, so what is asserted is what
 * lesser's SSR host would serve.
 *
 * THE COLLAPSE IS A ROUTE, NOT A CLASS, and that is the claim worth checking
 * hardest. `/messages/{conversationId}` is its own address, so below the
 * breakpoint the thread is not a hidden sibling pane — there is no off-screen
 * list holding a socket or a scroll position, and the browser's own back button
 * is the back affordance. Several assertions below exist to stop that quietly
 * becoming a CSS toggle later.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildSiteStylesheet } from '../scripts/build-stylesheet.mjs';
import { AUDIT_ROUTES, loadHandler, renderRoute } from '../scripts/render-routes.mjs';

const handler = await loadHandler();
const stylesheet = buildSiteStylesheet();
const route = (name) => AUDIT_ROUTES.find((entry) => entry.name === name);

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

/**
 * Every messaging TARGET, written as the selector that actually sizes it.
 *
 * Selectors rather than bare class names, because the two are not
 * interchangeable: the floor for the "load older" control lives on
 * `.contentus-messages__older button`, and a probe that looked up
 * `.contentus-messages__older` would read the flex container instead — and
 * report a floor the button might not have. This list is the one place the
 * distinction is recorded, so a control added without a floor fails here.
 */
const MESSAGING_TARGETS = [
	'.contentus-messages__tab',
	'.contentus-conversations__link',
	'.contentus-conversations__accept',
	'.contentus-conversations__decline',
	'.contentus-messages__back',
	'.contentus-messages__older button',
	'.contentus-messages__signin',
	'.messages-composer__input',
	'.messages-composer__send',
	'.messages-thread__request-button',
	'.message__content-warning-toggle',
	'.messages-thread__menu-trigger',
	'.new-conversation__trigger',
	'.new-conversation__button',
	'.new-conversation__close',
	'.new-conversation__input',
	'.new-conversation__result',
];

/**
 * Every top-level rule in the stylesheet, as `{ selectors, declarations }`.
 *
 * A small parser rather than a regex, because the thing being asked — "does
 * the rule for THIS selector carry the floor" — needs the selector LIST
 * separated from the declarations, and regexes over CSS get that wrong in
 * exactly the way that makes a probe pass while proving nothing. An earlier
 * version of this file matched `.contentus-messages__tabs` when it meant
 * `.contentus-messages__tab`, and then matched a container when it meant a
 * button.
 *
 * At-rule bodies are walked too, so a floor declared only inside a media block
 * still counts as declared.
 */
function cssRules(css) {
	const rules = [];
	let index = 0;

	while (index < css.length) {
		const open = css.indexOf('{', index);
		if (open === -1) break;

		const prelude = css.slice(index, open).trim();

		let depth = 0;
		let end = open;
		for (; end < css.length; end += 1) {
			if (css[end] === '{') depth += 1;
			else if (css[end] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}

		const body = css.slice(open + 1, end);
		if (prelude.startsWith('@')) {
			// An at-rule wraps rules rather than declarations; recurse into it.
			rules.push(...cssRules(body));
		} else {
			rules.push({
				selectors: prelude
					.split(',')
					.map((selector) => selector.replace(/\/\*[\s\S]*?\*\//g, '').trim())
					.filter(Boolean),
				declarations: body,
			});
		}

		index = end + 1;
	}

	return rules;
}

const RULES = cssRules(stylesheet);

/** Every rule whose selector list contains `selector` exactly. */
function rulesFor(selector) {
	return RULES.filter((rule) => rule.selectors.includes(selector));
}

test('the stylesheet gives every messaging target the 44px floor', () => {
	// §4's floor applies to the whole face, not only to the chrome around it. A
	// control listed here without a floor is one a thumb misses.
	for (const target of MESSAGING_TARGETS) {
		const rules = rulesFor(target);
		assert.ok(rules.length > 0, `${target} has no rule in the shipped stylesheet`);

		assert.ok(
			rules.some((rule) => /min-(height|width):\s*44px/.test(rule.declarations)),
			`${target} does not carry the 44px floor`
		);
	}
});

test('the stylesheet never lowers a messaging target below the floor', () => {
	// The floor is declared outside the media blocks, so the risk is a breakpoint
	// rule LOWERING it for a few pixels of label. Same check `mobile-chrome`
	// makes for the verdict controls.
	for (const breakpoint of [960, 720, 640, 480]) {
		const block = mediaBlocks(stylesheet, breakpoint);
		for (const match of block.matchAll(
			/((?:\.contentus-(?:messages|conversations)|\.messages-|\.message__|\.new-conversation)[^{}]*)\{([^}]*min-height:\s*(\d+(?:\.\d+)?)(px|rem)[^}]*)\}/g
		)) {
			const value = match[4] === 'rem' ? Number(match[3]) * 16 : Number(match[3]);
			assert.ok(
				value >= 44,
				`a ${breakpoint}px rule sizes "${match[1].trim()}" at ${match[3]}${match[4]}, below the floor`
			);
		}
	}
});

test('the stylesheet collapses the two panes at the same width the shell does', () => {
	// 961/960 rather than 960/959, and the pairing is the point: the shell hands
	// the sidebar to the tab bar in `@media (max-width: 960px)` — inclusive — so
	// 960 is a MOBILE width. A two-pane rule at `min-width: 960px` would put the
	// desktop layout and the mobile chrome on screen together at exactly that
	// width.
	assert.match(
		stylesheet,
		/@media \(min-width: 961px\)[^{]*\{[^]*?\.contentus-messages\[data-two-pane='true'\]/,
		'the two-pane layout must start at 961px'
	);

	const mobile = mediaBlocks(stylesheet, 960);
	assert.match(mobile, /\.messages-composer/, 'the 960px block must govern the composer');

	// And the component agrees with the stylesheet, rather than each having its
	// own opinion about where the collapse happens.
	const surface = readFileSync('src/lib/messaging/MessagingSurface.svelte', 'utf8');
	assert.match(
		surface,
		/TWO_PANE_QUERY = '\(min-width: 961px\)'/,
		'the component media query must match the stylesheet'
	);
});

test('the stylesheet sticks the composer above the tab bar and the safe area', () => {
	const block = mediaBlocks(stylesheet, 960);

	const composer = block.match(/\.messages-composer\s*\{([^}]*)\}/);
	assert.ok(composer, 'the composer has no rule at the mobile breakpoint');

	assert.match(composer[1], /position:\s*sticky/, 'the composer must not scroll away');

	// Both offsets, from the variables the shell already publishes rather than
	// re-measured here — the two must not be able to disagree about how tall the
	// tab bar is or how much home-indicator clearance a phone needs.
	assert.match(
		composer[1],
		/bottom:\s*calc\(var\(--contentus-tabbar-height\)\s*\+\s*var\(--contentus-safe-bottom\)\)/,
		'the composer must clear both the tab bar and the safe area'
	);

	// Opaque, because the thread scrolls underneath it.
	assert.match(
		composer[1],
		/background:/,
		'a sticky composer over a scrolling thread must be opaque'
	);
});

test('the stylesheet publishes the safe-area offset the composer reads', () => {
	// The composer's `calc()` is only correct if these are defined. They come
	// from the M3 chrome; asserting it here is what stops a later edit to
	// `bridge.css` silently pinning the composer to the wrong place.
	assert.match(stylesheet, /--contentus-tabbar-height:\s*\d+px/);
	assert.match(stylesheet, /--contentus-safe-bottom:\s*env\(safe-area-inset-bottom/);
});

test('the stylesheet scrolls the thread rather than the document', () => {
	// What makes the sticky composer work at all: if the document scrolls, a
	// composer pinned to the bottom of the surface walks off the page with it.
	const list = stylesheet.match(/\.messages-thread__list\s*\{([^}]*)\}/);
	assert.ok(list, 'the thread list has no rule');
	assert.match(list[1], /overflow-y:\s*auto/);
	assert.match(list[1], /min-height:\s*0/, 'a flex child needs min-height:0 to scroll');
});

test('the document gives the thread route a back affordance that is a real link', async () => {
	const surface = readFileSync('src/lib/messaging/MessagingSurface.svelte', 'utf8');

	// An anchor, not a button calling history.back(): it has to work before
	// hydration and on a cold deep link, which is exactly the case the pushed
	// route creates — somebody opening a conversation link from elsewhere has no
	// history entry to go back to.
	assert.match(
		surface,
		/<a class="contentus-messages__back" href=\{messagesHref\(folder\)\}/,
		'the back affordance must be a link to the list, not a history call'
	);
	assert.ok(
		!/history\.back\(\)/.test(surface),
		'the back affordance must not depend on a history entry a cold deep link does not have'
	);
});

test('the document renders conversation cards as links, so the collapse can be a route', async () => {
	const list = readFileSync('src/lib/messaging/ConversationList.svelte', 'utf8');

	// The card carries the conversation's own address. That is what lets the
	// mobile tap be a navigation (§5's "pushes as its own route") rather than a
	// class toggle, and it is also what makes middle-click and "open in new tab"
	// work on a desktop.
	assert.match(
		list,
		/href=\{conversationHref\(conversation\.id\)\}/,
		'the card must carry the conversation address'
	);

	// The plain click is intercepted for the in-place desktop selection, but the
	// modified clicks the browser owns are left alone.
	assert.match(
		list,
		/event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/,
		'modified clicks must be left to the browser'
	);
});

test('the document ships the messaging chrome on both messaging routes', async () => {
	for (const name of ['messages-inbox', 'message-thread']) {
		const rendered = await renderRoute(handler, route(name));

		// The mobile tab bar is on every route, and the messages surface is what
		// the tab it highlights leads to.
		assert.match(rendered.html, /class="contentus-tabbar"/, `${name} must ship the tab bar`);
		// Attribute order is the renderer's, not ours, so the two are matched
		// independently rather than as one fixed string.
		const viewport = rendered.html.match(/<meta[^>]*name="viewport"[^>]*>/);
		assert.ok(viewport, `${name} must carry a viewport meta`);
		assert.match(
			viewport[0],
			/content="width=device-width, initial-scale=1"/,
			`${name} must carry the viewport meta the chrome depends on`
		);
	}
});

test('the mobile tab bar anchors the unread badge to the icon, not the tab', async () => {
	const bar = readFileSync('src/lib/shell/MobileTabBar.svelte', 'utf8');

	// A badge that widened the tab would push a neighbouring target under the
	// 44px floor on a 360px phone — four tabs and a FAB is already the budget.
	assert.match(
		bar,
		/<span class="contentus-tabbar__icon">[\s\S]*?contentus-tabbar__unread/,
		'the badge must sit inside the icon wrapper'
	);

	const icon = stylesheet.match(/\.contentus-tabbar__icon\s*\{([^}]*)\}/);
	assert.ok(icon, '.contentus-tabbar__icon has no rule');
	assert.match(icon[1], /position:\s*relative/, 'the badge is absolutely positioned against it');

	const badge = stylesheet.match(/\.contentus-tabbar__unread\s*\{([^}]*)\}/);
	assert.ok(badge, '.contentus-tabbar__unread has no rule');
	assert.match(badge[1], /position:\s*absolute/, 'the badge must be out of flow');
});

test('the anonymous mobile bar shows no Messages tab', async () => {
	const rendered = await renderRoute(handler, route('messages-inbox'));

	// lesser serves no part of `conversations` anonymously, so an anonymous
	// reader is not offered a destination that would only refuse them. The tab
	// appears at hydration when there is a session — the same trade M1 made for
	// the sidebar, kept so the two navs cannot disagree about who sees what.
	const barStart = rendered.html.indexOf('class="contentus-tabbar"');
	const bar = rendered.html.slice(barStart, rendered.html.indexOf('</nav>', barStart));

	assert.ok(barStart !== -1, 'the tab bar should be in the document');
	assert.ok(
		!/contentus-tabbar__label">Messages</.test(bar),
		'the anonymous server render must not offer the Messages tab'
	);
	assert.ok(
		!/contentus-tabbar__unread/.test(bar),
		'there is no unread count to show before a session has been read'
	);
});

test('the stylesheet keeps the preview to one line', () => {
	// A wrapping preview turns the list into a reading surface and pushes the
	// next conversation off a phone's first screen.
	const preview = stylesheet.match(/\.contentus-conversations__preview\s*\{([^}]*)\}/);
	assert.ok(preview, 'the preview has no rule');
	assert.match(preview[1], /white-space:\s*nowrap/);
	assert.match(preview[1], /text-overflow:\s*ellipsis/);
	assert.match(preview[1], /overflow:\s*hidden/);
});

test('the stylesheet narrows the message bubble on a phone', () => {
	const block = mediaBlocks(stylesheet, 960);
	assert.match(
		block,
		/\.message__bubble\s*\{[^}]*max-width:\s*88%/,
		'a bubble sized for a desktop column wastes a phone screen'
	);
});

test('the request actions wrap rather than overflowing a narrow card', () => {
	const actions = stylesheet.match(/\.contentus-conversations__actions\s*\{([^}]*)\}/);
	assert.ok(actions, 'the request actions have no rule');

	// Two 44px buttons plus their gap will not fit beside each other on the
	// narrowest phone the design covers; wrapping is what keeps both reachable
	// instead of clipping one.
	assert.match(actions[1], /flex-wrap:\s*wrap/);
});
