/**
 * The vendored `ContentRenderer`'s rendering pipeline, pinned on both branches.
 *
 * THIS FILE USED TO PIN A DEFECT. `ContentRenderer` sanitized lesser's HTML and
 * then, for any status carrying neither mentions nor tags, passed the RESULT to
 * `linkifyMentions` — a PLAIN-TEXT linkifier whose first line escapes every `<`.
 * The escaped string was written to `innerHTML` through a Svelte action, so
 * `<p>Hello <strong>world</strong></p>` reached the reader as literal text, and
 * only for ordinary posts: statuses with an @ or a # took the other branch and
 * rendered correctly. The action also meant nothing server-rendered at all.
 *
 * greater-v0.13.0 fixed both. `processContent` now linkifies with `linkifyHtml`,
 * which walks text nodes and leaves markup alone, and the component renders
 * `{@html processedContent}` declaratively so the body is in the server's paint
 * (`tests/ssr-timelines.test.mjs` holds that half).
 *
 * SO THE PINS ARE INVERTED, NOT DELETED. The old file's own header named the
 * forcing function — "the corrupting branch fails the day upstream FIXES it" —
 * and that day came. What replaces it is the same probe pointed the other way:
 * BOTH branches must now preserve markup, and the day either one starts
 * escaping again is a failure here rather than a silent regression that reaches
 * readers as `&lt;p&gt;`. A fixed defect with no test is a defect waiting to
 * come back.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COMPONENT = 'src/lib/components/ContentRenderer.svelte';
const component = readFileSync(join(repoRoot, COMPONENT), 'utf8');

/**
 * The component's own `processContent`, EXECUTED — not reproduced.
 *
 * `processContent` is an instance-closure function inside a `.svelte` file, so
 * it is neither exported nor reachable without a DOM. Reproducing the pipeline
 * in test code was an earlier approach here and is exactly what let a branch go
 * unpinned: a reproduction agrees with itself no matter what the vendored file
 * says.
 *
 * So the region carrying the function is sliced VERBATIM out of the component
 * and evaluated as a module. Node strips the type annotations, nothing else is
 * transformed, and the closure variables the component supplies as props become
 * parameters. The code that runs is the code in the file, byte for byte, which
 * is the only form of this probe that bites when the file changes.
 *
 * The slice boundaries are asserted rather than assumed. A refactor that moves
 * the function out of this region must fail loudly — a probe that silently
 * extracts nothing and passes is the failure mode this repo has already paid
 * for. (It fired at the v0.13.0 bump, which is how the rewrite got written.)
 */
async function extractProcessContent() {
	const START = 'function processContent(html: string): string {';
	const END = 'const processedContent = $derived(';

	const from = component.indexOf(START);
	const to = component.indexOf(END);
	assert.ok(
		from !== -1 && to !== -1 && to > from,
		`${COMPONENT} no longer has the region this probe extracts (${START} … ${END}). ` +
			'Re-anchor the slice on the real source; do not delete the probe.'
	);

	const slice = component.slice(from, to);
	for (const required of ['sanitizeHtml(html, {', 'return linkifyHtml(sanitized, {']) {
		assert.ok(
			slice.includes(required),
			`the extracted region no longer contains \`${required}\`, so these probes would be ` +
				'driving something other than the component. Re-anchor the slice.'
		);
	}

	const utils = resolve(repoRoot, 'src/lib/greater/utils');
	const href = (name) => JSON.stringify(pathToFileURL(join(utils, name)).href);
	// The concrete modules, not the barrel: `utils/index.ts` re-exports with `.js`
	// specifiers that Node's resolver cannot follow to a `.ts` file.
	const source = `
import { linkifyHtml } from ${href('linkifyMentions.ts')};
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
		rmSync(dir, { recursive: true, force: true });
	}
}

const bindProcessContent = await extractProcessContent();

/** A status with no mentions and no tags: the ordinary post, and the branch that used to corrupt. */
const ordinary = bindProcessContent();
/** The same component, given the mention data lesser returns for a post with an @. */
const withMentions = bindProcessContent({
	mentions: [{ id: '1', username: 'ada', acct: 'ada@example.invalid', url: '/users/ada' }],
});
/** And with the tag data lesser returns for a post with a #. */
const withTags = bindProcessContent({ tags: [{ name: 'lesser', url: '/tags/lesser' }] });

/** A body in the shape lesser's sanitizer actually emits. */
const SANITIZED = '<p>Hello <strong>world</strong></p>';

test('the ordinary post keeps its markup — the branch that used to escape it', () => {
	// THE REGRESSION GUARD THIS FILE EXISTS FOR. A status carrying neither
	// mentions nor tags is the common case and was the corrupt one: the whole
	// body arrived as literal `&lt;p&gt;Hello …`.
	const out = ordinary(SANITIZED);

	assert.match(out, /<strong>world<\/strong>/, 'markup must survive as markup');
	assert.ok(!out.includes('&lt;p&gt;'), 'and must not be escaped into literal text');
	assert.ok(!out.includes('&lt;strong&gt;'));
});

test('the mentions branch keeps its markup too, and still linkifies', () => {
	const out = withMentions('<p>Hi <strong>@ada</strong></p>');

	assert.match(out, /<strong>/, 'markup survives');
	assert.ok(!out.includes('&lt;'), 'nothing is escaped');
	assert.match(out, /\/users\/ada/, 'and the mention became a link');
});

test('the tags branch keeps its markup too, and still linkifies', () => {
	const out = withTags('<p>About <strong>#lesser</strong></p>');

	assert.match(out, /<strong>/);
	assert.ok(!out.includes('&lt;'));
	assert.match(out, /\/tags\/lesser/);
});

test('all three branches agree, which is what "fixed" means here', () => {
	// The old defect was branch-dependent — that is why it survived casual
	// inspection for so long. Asserting the branches AGREE catches a future
	// divergence that per-branch probes could each still pass.
	const outputs = [ordinary(SANITIZED), withMentions(SANITIZED), withTags(SANITIZED)];

	for (const out of outputs) {
		assert.ok(!out.includes('&lt;'), 'no branch escapes sanitized markup');
	}
	assert.equal(
		new Set(outputs).size,
		1,
		'a body with no mentions and no tags must render identically whatever those props hold'
	);
});

test('sanitization still runs, and still runs first', () => {
	// The fix must not have been "stop escaping" alone. Defence in depth over
	// lesser's own sanitizer is the reason this component is allowed an
	// `{@html}` at all.
	const out = ordinary('<p>ok</p><script>alert(1)</script>');

	assert.ok(!out.includes('<script'), 'a script tag must not survive the pipeline');
	assert.match(out, /<p>ok<\/p>/, 'while ordinary markup passes through');
});

test('the body is rendered declaratively, so it server-renders', () => {
	// The other half of the upstream fix, asserted at the source because its
	// runtime effect is an SSR property (`tests/ssr-timelines.test.mjs` holds
	// that end). The action this replaced never ran on the server.
	assert.match(component, /\{@html processedContent\}/, 'declarative, not an action');
	assert.ok(!component.includes('use:setHtml'), 'the client-only action is gone');
});

test('the vendored source carrying this behaviour is unedited', () => {
	// The whole file is only meaningful if the component is upstream's. A
	// hand-edit here would be the repair this repository refuses, and would make
	// every assertion above a statement about contentus rather than about greater.
	const components = JSON.parse(readFileSync(join(repoRoot, 'components.json'), 'utf8'));
	const entry = components.installed.find((item) => item.name === 'content');

	assert.ok(entry, 'the `content` module must be a recorded vendored install');
	assert.equal(entry.modified, false, 'and must not be marked locally modified');
});
