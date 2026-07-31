/**
 * The vendored `ContentRenderer`'s HYDRATED behaviour, pinned on BOTH branches.
 *
 * `tests/ssr-timelines.test.mjs` pins the other half — that no status body
 * server-renders at all, because the component writes through a Svelte action.
 * This file pins what happens once the action DOES run, which for one branch is
 * worse and was undisclosed: the body arrives, and it arrives corrupted.
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
 * BOTH BRANCHES ARE PINNED, AND THAT IS THE POINT OF THE EXTRACTION BELOW.
 * The disclosure this file justifies claims a BOUND — "some posts, not all",
 * because statuses carrying mentions or tags render correctly — and an
 * unpinned bound is a claim that decays silently. An earlier version of this
 * file reproduced the corrupting branch in local code and asserted the intact
 * branch only through `sanitizeHtml`, so the vendored mentions branch could
 * start escaping its markup with every probe here still green: the disclosure
 * would go on saying "some posts" while every post was corrupt. Both branches
 * now run the component's REAL `processContent`, so a change to either one is
 * a failure here.
 *
 * EVERY PIN IS TWO-DIRECTIONAL. The corrupting branch fails the day upstream
 * FIXES it — the forcing function to delete this file, drop the disclosure from
 * `TimelineFeed.svelte`, and restore the body assertions in the SSR probes. The
 * intact branch fails the day upstream BREAKS it, which is the day the
 * disclosure has to stop saying "some".
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { linkifyMentions } from '../src/lib/greater/utils/linkifyMentions.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COMPONENT = 'src/lib/components/ContentRenderer.svelte';
const component = readFileSync(join(repoRoot, COMPONENT), 'utf8');

/**
 * The component's own `processContent`, EXECUTED — not reproduced.
 *
 * `processContent` is an instance-closure function inside a `.svelte` file, so
 * it is neither exported nor reachable without a DOM: the component writes its
 * output through a Svelte action, and mounting one needs a browser the test
 * runner does not have. Reproducing the pipeline in test code was the previous
 * approach and is what left the intact branch unpinned — a reproduction agrees
 * with itself no matter what the vendored file says.
 *
 * So the region carrying the function and its two helpers is sliced VERBATIM
 * out of the component and evaluated as a module: Node strips the type
 * annotations, nothing else is transformed, and the closure variables the
 * component supplies as props (`mentions`, `tags`, and the two base URLs)
 * become parameters. The code that runs is the code in the file, byte for byte,
 * which is the only form of this probe that bites when the file changes.
 *
 * The slice boundaries are asserted rather than assumed. A refactor that moves
 * either branch out of this region must fail loudly here — a probe that
 * silently extracts nothing and passes is the failure mode this repo has
 * already paid for.
 */
async function extractProcessContent() {
	const START = 'const allowedLinkProtocols = new Set(';
	const END = 'const processedContent = $derived(';

	const from = component.indexOf(START);
	const to = component.indexOf(END);
	assert.ok(
		from !== -1 && to !== -1 && to > from,
		`${COMPONENT} no longer has the region this probe extracts (${START} … ${END}). ` +
			'Re-anchor the slice on the real source; do not delete the probe.'
	);

	const slice = component.slice(from, to);
	for (const required of [
		'function processContent(html: string): string',
		'if (mentions.length > 0) {',
		'if (tags.length > 0) {',
		'if (mentions.length === 0 && tags.length === 0) {',
	]) {
		assert.ok(
			slice.includes(required),
			`the extracted region no longer contains \`${required}\`, so these probes would be ` +
				'driving something other than the component. Re-anchor the slice.'
		);
	}

	const utils = resolve(repoRoot, 'src/lib/greater/utils');
	const href = (name) => JSON.stringify(pathToFileURL(join(utils, name)).href);
	const source = `
import { linkifyMentions } from ${href('linkifyMentions.ts')};
import { sanitizeHtml } from ${href('sanitizeHtml.ts')};

export function bind(props) {
	const { mentions, tags, mentionBaseUrl, hashtagBaseUrl } = props;
${slice}
	return processContent;
}
`;

	const dir = mkdtempSync(join(tmpdir(), 'contentus-content-renderer-'));
	try {
		const file = join(dir, 'extracted-process-content.ts');
		writeFileSync(file, source, 'utf8');
		const module = await import(pathToFileURL(file).href);
		return (props = {}) =>
			module.bind({
				mentions: [],
				tags: [],
				mentionBaseUrl: '/users/',
				hashtagBaseUrl: '/tags/',
				...props,
			});
	} finally {
		// The module is evaluated and cached by now, so the file on disk has done
		// its job. Nothing is left behind for a later run to pick up stale.
		rmSync(dir, { recursive: true, force: true });
	}
}

const bindProcessContent = await extractProcessContent();

/** A status with no mentions and no tags: the ordinary post, and the corrupt branch. */
const ordinary = bindProcessContent();
/** The same component, given the mention data lesser returns for a post with an @. */
const withMention = bindProcessContent({
	mentions: [{ username: 'ada', url: 'https://example.invalid/users/ada' }],
});
/** And with the tag data lesser returns for a post with a #. */
const withTag = bindProcessContent({
	tags: [{ name: 'engines', url: 'https://example.invalid/tags/engines' }],
});

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
	const rendered = ordinary('<p>Hello <strong>world</strong></p>');

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

test('the MENTIONS branch renders its markup intact, which is the disclosure’s bound', () => {
	// The half that was accurate but unpinned. The feed tells readers that only
	// SOME posts are affected, and the reason that is true is this branch: a
	// status carrying mentions never reaches `linkifyMentions`, so its markup
	// survives to the DOM as markup. If this branch starts escaping too, "some"
	// becomes a false claim about every post on the instance, and it must fail
	// here rather than go unnoticed.
	const body = '<p>Hi <strong>there</strong> @ada</p>';
	const rendered = withMention(body);

	assert.ok(
		rendered.includes('<p>') && rendered.includes('<strong>there</strong>'),
		'BAD NEWS IF THIS FAILS: the mentions branch now corrupts bodies too, so the defect is ' +
			'no longer bounded. Widen the .contentus-feed__gap disclosure in ' +
			'src/lib/timelines/TimelineFeed.svelte to say EVERY post, and re-report upstream.'
	);
	assert.ok(
		!rendered.includes('&lt;'),
		'nothing in this branch may be escaped — an escaped `<` here is the corruption arriving'
	);

	// The branch is not merely non-destructive, it does the job it exists for.
	// Asserted so "intact" cannot be satisfied by a branch that stopped running:
	// a `processContent` that returned its input untouched would pass the two
	// assertions above and would be a different defect.
	assert.match(
		rendered,
		/<a href="https:\/\/example\.invalid\/users\/ada" class="mention"[^>]*>@ada<\/a>/,
		'the mention lesser named is linked, so this branch is doing its work rather than idling'
	);
});

test('the TAGS branch renders its markup intact too', () => {
	// The same claim for the other non-corrupting entry. `tags.length > 0` is a
	// separate condition in the component, so a change could break one branch and
	// leave the other — and a post carrying only a hashtag takes this one alone.
	const rendered = withTag('<p>On <strong>engines</strong> #engines</p>');

	assert.ok(
		rendered.includes('<strong>engines</strong>'),
		'BAD NEWS IF THIS FAILS: the tags branch now corrupts bodies too. Widen the disclosure ' +
			'in src/lib/timelines/TimelineFeed.svelte and re-report upstream.'
	);
	assert.ok(!rendered.includes('&lt;'), 'nothing in this branch may be escaped either');
	assert.match(
		rendered,
		/<a href="https:\/\/example\.invalid\/tags\/engines" class="hashtag"[^>]*>#engines<\/a>/,
		'the hashtag lesser named is linked'
	);
});

test('PINNED GAP: the corrupting branch is the one ordinary posts take', () => {
	// The differential, on ONE input through the component's real function twice.
	// This is what makes the scope of the disclosure evidence rather than prose:
	// the same body is destroyed when lesser reports no mentions and preserved
	// when it reports one, and nothing about the body itself differs.
	const body = '<p>Hi <strong>there</strong> @ada</p>';

	assert.ok(ordinary(body).includes('&lt;strong&gt;'), 'no mentions: the markup is escaped');
	assert.ok(withMention(body).includes('<strong>'), 'mentions present: the markup survives');

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
	const util = readFileSync(join(repoRoot, 'src/lib/greater/utils/linkifyMentions.ts'), 'utf8');

	assert.match(util, /let result = escapeHtml\(text\);/);
	assert.match(component, /use:setHtml=\{processedContent\}/);
});
