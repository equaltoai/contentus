/**
 * The vendored `ContentRenderer`'s HYDRATED defect, pinned.
 *
 * `tests/ssr-timelines.test.mjs` pins the other half — that no status body
 * server-renders at all, because the component writes through a Svelte action.
 * This file pins what happens once the action DOES run, which is worse and was
 * undisclosed: the body arrives, and it arrives corrupted.
 *
 * THE DEFECT, in the component's own order of operations
 * (`src/lib/components/ContentRenderer.svelte` → `processContent`):
 *
 *   1. `sanitizeHtml(content)` — lesser's server-sanitized HTML, sanitized again
 *      as defence in depth. Still HTML at this point, and correct.
 *   2. if the status carries NO mentions and NO tags, the sanitized HTML is
 *      passed to `linkifyMentions(...)`, whose first line is
 *      `let result = escapeHtml(text)` — every `<` becomes `&lt;`.
 *   3. the escaped string is written to `node.innerHTML` by the `setHtml` action.
 *
 * So `<p>Hello <strong>world</strong></p>` reaches the reader as the LITERAL
 * TEXT `<p>Hello <strong>world</strong></p>`. `linkifyMentions` is written for
 * PLAIN TEXT — escaping is correct there — and the component hands it HTML.
 * A status that carries mentions or tags takes the other branch and renders
 * correctly, which is why the defect survives casual inspection: it hits
 * ordinary posts and spares the ones with @ or # in them.
 *
 * WHY THIS IS PINNED RATHER THAN FIXED HERE. Vendored source is never
 * hand-edited. There is no supported prop that disables the linkify step — the
 * assertion below reads the component's own `Props` interface to hold that
 * claim honest — and supplying fabricated `mentions` to steer the branch would
 * be inventing content to route around a rendering bug. An owned `{@html}`
 * status component is what check 3 of the renderer-authority audit exists to
 * forbid. So: reported upstream, pinned here, and disclosed in the feed.
 *
 * EVERY ASSERTION BELOW IS INVERTED. Each one fails the day upstream fixes
 * this, which is the forcing function to delete this file, drop the disclosure
 * from `TimelineFeed.svelte`, and restore the body assertions in the SSR probes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { linkifyMentions } from '../src/lib/greater/utils/linkifyMentions.ts';
import { sanitizeHtml } from '../src/lib/greater/utils/sanitizeHtml.ts';

const COMPONENT = 'src/lib/components/ContentRenderer.svelte';
const component = readFileSync(COMPONENT, 'utf8');

/**
 * The component's own pipeline for a status with no mentions and no tags,
 * reproduced from its source rather than paraphrased: sanitize, then linkify.
 * What this returns is exactly what `use:setHtml` assigns to `innerHTML`.
 */
function processContentWithoutMentionsOrTags(html) {
	const sanitized = sanitizeHtml(html, {
		allowedTags: ['p', 'br', 'span', 'a', 'em', 'strong', 'b', 'i', 'code', 'pre', 'blockquote'],
		allowedAttributes: ['href', 'title', 'class', 'rel', 'target'],
	});

	return linkifyMentions(sanitized, {
		mentionBaseUrl: '/users/',
		hashtagBaseUrl: '/tags/',
		openInNewTab: true,
		nofollow: false,
	});
}

test('PINNED GAP: linkifyMentions escapes the HTML it is handed', () => {
	// The root cause, at the function that carries it. `linkifyMentions` is a
	// PLAIN-TEXT helper — escaping its input is right for the job it was written
	// for — and the defect is that the component feeds it markup.
	const escaped = linkifyMentions('<p>Hello <strong>world</strong></p>');

	assert.ok(
		escaped.includes('&lt;p&gt;'),
		'GOOD NEWS IF THIS FAILS: linkifyMentions no longer escapes its input. Re-check ' +
			'ContentRenderer and delete this file if status bodies now render.'
	);
	assert.ok(!escaped.includes('<strong>'), 'the markup does not survive');
});

test('PINNED GAP: an ordinary status body renders as literal markup after hydration', () => {
	// End to end through the component's real pipeline, on the shape lesser
	// actually returns: server-sanitized HTML, no mentions, no tags.
	const rendered = processContentWithoutMentionsOrTags('<p>Hello <strong>world</strong></p>');

	assert.ok(
		rendered.includes('&lt;p&gt;') && rendered.includes('&lt;strong&gt;'),
		'GOOD NEWS IF THIS FAILS: hydrated status bodies now render as HTML. Delete this file, ' +
			'drop the .contentus-feed__gap disclosure from src/lib/timelines/TimelineFeed.svelte, ' +
			'and restore the body assertions in tests/ssr-timelines.test.mjs.'
	);
	assert.ok(
		!/<(p|strong)>/.test(rendered),
		'no element from the original body survives to reach the DOM as an element'
	);

	// And what that means on screen, stated as the assertion rather than left in
	// prose: the reader sees the tags.
	assert.equal(
		rendered.replace(/&lt;/g, '<').replace(/&gt;/g, '>').includes('<p>Hello <strong>world'),
		true,
		'the escaped text IS the original markup, shown rather than applied'
	);
});

test('PINNED GAP: the corrupting branch is the one ordinary posts take', () => {
	// Read from the component so a change to its composition breaks this rather
	// than silently emptying it. `mentions.length === 0 && tags.length === 0` is
	// the branch: the majority of posts, and the ones with no @ or # to hint that
	// anything is different about them.
	assert.match(
		component,
		/if \(mentions\.length === 0 && tags\.length === 0\) \{\s*\n\s*processed = linkifyMentions\(/,
		'GOOD NEWS IF THIS FAILS: ContentRenderer no longer routes sanitized HTML through ' +
			'linkifyMentions. Verify the rendered output and delete this file.'
	);

	// A status WITH mentions takes the other branch and is unaffected. Asserted
	// so the disclosure in the feed stays accurate about scope — "some posts",
	// not "all posts" — rather than being vaguer than the evidence.
	const withMentions = sanitizeHtml('<p>Hi <strong>there</strong> @ada</p>', {
		allowedTags: ['p', 'strong', 'a'],
		allowedAttributes: ['href', 'class', 'rel', 'target'],
	});
	assert.ok(
		withMentions.includes('<strong>'),
		'sanitization alone preserves markup; only the linkify step destroys it'
	);
});

test('PINNED GAP: the component exposes no supported way to skip the linkify step', () => {
	// The question asked before pinning: is there a CONFIG for this? If the
	// component took `linkify={false}`, using it would be the fix and pinning
	// would be wrong. It does not. The `Props` interface is the whole supported
	// surface, and none of its members turns the step off — the only prop-driven
	// escape is supplying non-empty `mentions`/`tags`, which are content lesser
	// states, not a rendering switch. Fabricating them to steer a branch would be
	// inventing content to route around a rendering bug, and it would wrap any
	// text matching the invented handle in a link besides.
	const props = /interface Props \{([\s\S]*?)\n\t\}/.exec(component)?.[1];
	assert.ok(props, `${COMPONENT} must declare a Props interface for this probe to mean anything`);

	// MEMBER NAMES ONLY. The interface's JSDoc says "Mentions to linkify" and
	// "Hashtags to linkify", so scanning the block as text finds the word and
	// proves nothing — a probe that reads prose is the failure this repo has
	// already paid for twice.
	const members = [...props.matchAll(/^\t\t(\w+)\??:/gm)].map((match) => match[1]);

	assert.deepEqual(
		members,
		[
			'content',
			'spoilerText',
			'collapsed',
			'mentions',
			'tags',
			'mentionBaseUrl',
			'hashtagBaseUrl',
			'class',
			'onToggle',
		],
		'GOOD NEWS IF THIS MOVED: the supported prop surface changed. Re-ask whether the linkify ' +
			'step can now be skipped, and if it can, use that instead of keeping this pin.'
	);

	for (const member of members) {
		assert.doesNotMatch(
			member,
			/linkify|autolink|plaintext|raw|skip|disable/i,
			`GOOD NEWS IF THIS FAILS: \`${member}\` looks like a supported switch for the linkify ` +
				'step. Pass it from StatusCard instead of keeping this pin.'
		);
	}
});

test('the vendored source carrying this defect is unedited', () => {
	// The other half of the invariant, and the reason this is a pin at all: the
	// fix is upstream's, so the file must still be byte-for-byte theirs. If the
	// escaping ever disappears from the vendored util, it was either fixed
	// upstream (delete this file) or edited locally (revert it).
	const util = readFileSync('src/lib/greater/utils/linkifyMentions.ts', 'utf8');

	assert.match(util, /let result = escapeHtml\(text\);/);
	assert.match(component, /use:setHtml=\{processedContent\}/);
});
