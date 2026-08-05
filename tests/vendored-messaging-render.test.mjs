/**
 * The vendored messaging suite's rendering, pinned — and the disclosure it once
 * required, withdrawn.
 *
 * WHAT THE DEFECT WAS. lesser's `Object.content` is server-sanitized HTML — that
 * is the renderer-authority contract, and every other contentus surface treats
 * it as such. Both `Messages.Message` and `Messages.Conversations` rendered it
 * with `{message.content}`, Svelte's ESCAPING interpolation, so a body arrived
 * in the DOM as its own markup shown as literal text. contentus could not repair
 * it — vendored source is never hand-edited, an `{@html}` in owned source is what
 * check 3 of `audit-renderer-authority.mjs` forbids — so it was disclosed on the
 * surface and routed upstream.
 *
 * BOTH HALVES ARE FIXED AT greater-v0.13.0, and by two different correct
 * answers:
 *
 *   - `Message.svelte` sanitizes with its own `sanitizeMessageHtml` and renders
 *     `{@html sanitizedMessageContent}`. Thread bodies are markup again.
 *   - `Conversations.svelte` runs the LIST preview through
 *     `sanitizeMessagePreview`, which returns markup-free, entity-decoded,
 *     whitespace-collapsed, length-capped TEXT. The escaping interpolation
 *     stays, and is right: escaping text yields text.
 *
 * WHY THE SECOND HALF SURVIVED A ROUND OF REVIEW AS A "GAP". The old probe
 * asserted the compiled sink — `$.escape(getMessagePreview(...))` — and then
 * demonstrated the consequence by escaping the RAW sanitized body. That is not
 * what the component does. The sink was real and the input was imagined, so the
 * probe went on agreeing with a disclosure whose defect had gone. A test that
 * models one end of a pipeline proves nothing about the other end.
 *
 * SO THE PIPELINE IS DRIVEN, END TO END: the REAL vendored components compiled
 * by the REAL Svelte compiler, the REAL `sanitizeMessagePreview` they call, and
 * the REAL `escape` from `svelte/internal/server` applied to its result. The
 * assertions describe the WORKING behaviour and go red if either sink regresses
 * — which is also the day a disclosure would be owed again.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { compile } from 'svelte/compiler';
import { escape } from 'svelte/internal/server';

// THE GATE'S OWN SCANNER, imported rather than reproduced. It used to be copied
// into this file, and the copies were byte-identical — which is the state that
// ends with them not being: a regression passing against its duplicate while the
// gate scans something else. The nested-delimiter case below now drives the code
// `scripts/audit-renderer-authority.mjs` actually runs, and
// `tests/renderer-authority-audit.test.mjs` plants the same case as a real file
// and runs the real audit over it.
import { stripComments } from '../scripts/lib/strip-comments.mjs';

/**
 * Resolve the vendored barrel the way the build does, so Node can load the REAL
 * sanitizer rather than a model of it.
 *
 * `src/lib/components/messaging/sanitize.ts` imports exactly one name —
 * `sanitizeHtml` — from `../../greater/utils`. That barrel is a directory (Node
 * does not resolve those), and it also re-exports a `.svelte` component and the
 * dormant `html-to-markdown` branch whose Markdown dependencies contentus
 * deliberately does not install; `vite.config.ts` aliases those to a throwing
 * stub for the same reason. Node has neither behaviour, so this hook points the
 * barrel at the real module that owns the export this pipeline uses.
 *
 * NOTHING IS STUBBED AND NOTHING IS REIMPLEMENTED. `sanitizeHtml` is the
 * vendored implementation loaded from the vendored file; the hook only supplies
 * the resolution vite would have. The alternative — asserting on the sanitizer's
 * source text — is precisely the "model one end of the pipeline" mistake this
 * file exists to stop repeating.
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '../../greater/utils') {
			return {
				url: new URL('../src/lib/greater/utils/sanitizeHtml.ts', import.meta.url).href,
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

// Dynamic, because the hook above has to be registered before the module graph
// beneath it is resolved, and static imports are hoisted past it.
const { sanitizeMessagePreview } = await import('../src/lib/components/messaging/sanitize.ts');

/** Compile a vendored component exactly as the build does for the server pass. */
function compileServer(path) {
	const source = readFileSync(path, 'utf8');
	return compile(source, { generate: 'server', name: 'Probe' }).js.code;
}

const MESSAGE = 'src/lib/components/messaging/Message.svelte';
const CONVERSATIONS = 'src/lib/components/messaging/Conversations.svelte';

/** A body in the shape lesser's sanitizer actually emits. */
const SANITIZED = '<p>Hello <strong>world</strong></p>';

test('the message body is no longer escaped — the half upstream fixed', () => {
	// THIS PROBE USED TO ASSERT THE OPPOSITE, and its failure message said that
	// failing meant upstream had fixed it. greater-v0.13.0 did: `Message.svelte`
	// sanitizes through its own `sanitize.ts` and renders `{@html}`, so the body
	// reaches the reader as markup.
	//
	// Inverted rather than deleted. The compiler's own output is still what is
	// read — `{expr}` compiles to `$.escape(expr)` and `{@html expr}` to a raw
	// push — so a regression to the escaping sink fails here rather than
	// reaching readers as literal `<p>`.
	const code = compileServer(MESSAGE);

	const escapedBody = code.match(
		/message__content"[^`]*?\$\.escape\(([^)]*message\.content[^)]*)\)/
	);
	assert.equal(escapedBody, null, 'the body must not be emitted through the escaping sink');

	const source = readFileSync(MESSAGE, 'utf8');
	assert.match(source, /\{@html sanitizedMessageContent\}/, 'it is rendered declaratively');
	assert.match(
		source,
		/sanitizeMessageHtml\(message\.content\)/,
		'through the component’s own sanitizer, which is what earns the raw sink'
	);
});

test('the conversation preview reaches the escaping sink as TEXT, not as markup', () => {
	const code = compileServer(CONVERSATIONS);
	const source = readFileSync(CONVERSATIONS, 'utf8');

	// The compiled sink is unchanged — the preview is still `$.escape(...)` — but
	// what reaches it is not. THIS is the half the old probe got wrong: it
	// asserted the escape call and inferred the consequence, when the consequence
	// depends entirely on what `getMessagePreview` returns.
	assert.ok(
		/\$\.escape\(getMessagePreview\(/.test(code),
		'the preview is still rendered through the escaping interpolation'
	);
	assert.ok(
		!/\$\.html\(/.test(code),
		'and the list has no raw HTML sink, which is correct for text'
	);

	// And it is markup-free by the time it gets there, because the component runs
	// it through its own sanitizer first.
	assert.match(
		source,
		/return sanitizeMessagePreview\(message\.content, 200\)/,
		'the preview must be extracted by the component’s sanitizer, not interpolated raw'
	);
});

test('the real preview sanitizer turns a sanitized body into readable text', () => {
	// THE PIPELINE, DRIVEN. Not `escape(SANITIZED)` — that was the old probe's
	// mistake: it escaped the RAW body, which is not what the component does, and
	// then reported the literal-markup output as the reader's screen.
	//
	// This runs the REAL `sanitizeMessagePreview` the REAL component calls, then
	// the REAL `escape` from Svelte's server runtime that the compiled template
	// applies to its result. What comes out is what a reader sees.
	const preview = sanitizeMessagePreview(SANITIZED, 200);
	const rendered = escape(preview);

	assert.equal(preview, 'Hello world', 'the sanitizer extracts text, tags and all');
	assert.equal(rendered, 'Hello world', 'and escaping text is a no-op — no markup is shown');

	// The specific thing the withdrawn disclosure claimed a reader would see.
	assert.ok(!rendered.includes('&lt;'), 'no escaped angle bracket reaches the reader');
	assert.ok(!rendered.includes('<p>'), 'and no element is produced from a preview line either');
});

test('the preview sanitizer decodes, collapses and caps rather than truncating markup', () => {
	// The properties that make "text by design" a real answer rather than a
	// downgrade, each driven through the real function.
	assert.equal(
		sanitizeMessagePreview('<p>a &amp; b</p><p>c</p>', 200),
		'a & b c',
		'entities are decoded and block boundaries become one space'
	);
	assert.equal(
		sanitizeMessagePreview('<script>alert(1)</script><p>safe</p>', 200),
		'safe',
		'the shared allow-list sanitizer runs first, so a script body is not preview text'
	);

	const capped = sanitizeMessagePreview(`<p>${'x'.repeat(400)}</p>`, 200);
	assert.equal(capped, `${'x'.repeat(200)}...`, 'and the cap counts characters, not bytes or tags');
});

test('the component exposes no prop that would change the sink', () => {
	const source = readFileSync(MESSAGE, 'utf8');

	// This is what makes the gap unfixable from here rather than merely unfixed.
	// If a prop appears that selects a raw sink, contentus should use it and this
	// assertion should fail.
	const props = source.match(/interface Props \{([\s\S]*?)\n\t\}/);
	assert.ok(props, 'could not read the Props interface');

	const names = [...props[1].matchAll(/^\s*(\w+)[?:]/gm)].map((m) => m[1]);
	assert.deepEqual(
		names.sort(),
		['class', 'currentUserId', 'message'],
		'the Props surface changed — check whether a rendering prop was added upstream'
	);
});

test('the withdrawn disclosure is gone from the surface and from the stylesheet', () => {
	// It was rendered unconditionally, which was right while it was true. Both
	// sinks are fixed upstream, so the notice is withdrawn rather than narrowed
	// again — a disclosure kept past its defect tells a reader their instance is
	// mangling what was sent when it is not.
	//
	// Asserted on both files because a class left behind in the stylesheet is how
	// a withdrawn notice comes back: the rule survives, someone re-adds the
	// element to match it, and nothing fails.
	const surface = readFileSync('src/lib/messaging/MessagingSurface.svelte', 'utf8');
	const stylesheet = readFileSync('src/lib/brand/messaging.css', 'utf8');
	const notice = 'contentus-messages__gap';

	// Comments are stripped with the GATE'S scanner, not with a replace: the
	// template still EXPLAINS the withdrawal in prose, and a check that failed on
	// the explanation would be measuring its own documentation.
	const template = stripComments(surface.slice(surface.indexOf('</script>')));
	assert.ok(!template.includes(notice), 'the withdrawn disclosure must not still be rendered');
	assert.ok(
		!stripComments(stylesheet).includes(notice),
		'and its stylesheet rule goes with it — a rule left behind is how the notice comes back'
	);

	// The other disclosures on this surface are untouched: they report transport
	// state, which is still a thing that happens.
	assert.ok(template.includes('contentus-messages__realtime'));
});

test('the comment stripper reads a nested delimiter the way a parser does', () => {
	// The case that decided the implementation, kept as a regression rather than
	// as prose, and run against the GATE'S OWN function — the import at the top
	// of this file is the whole point of the test. A parser reading this finds
	// its first `<!--` at index 2, so the comment is `<!-- -->` and the sink
	// after it is LIVE template.
	const nested = '<!<!-- -->-- {@html evil} -->';

	assert.match(
		stripComments(nested),
		/\{@html evil\}/,
		'a live sink must survive the strip, so the audit can catch it'
	);

	// The regex form that CodeQL flagged, and the loop-until-stable fix that rule
	// recommends, both get this WRONG in the dangerous direction: one pass
	// reintroduces `<!-- … -->`, and a second deletes the sink with it. Asserted
	// so the reasoning cannot quietly be undone by somebody "simplifying" this
	// back into a replace.
	let looped = nested;
	let previous;
	do {
		previous = looped;
		looped = looped.replace(/<!--[\s\S]*?-->/g, '');
	} while (looped !== previous);
	assert.equal(
		looped,
		'',
		'the looped replace is supposed to eat the sink — that is why it is not used'
	);

	// Ordinary comments still go, so the scan did not become a no-op.
	assert.equal(
		stripComments('<p>keep</p><!-- drop --><span>keep</span>'),
		'<p>keep</p><span>keep</span>'
	);
	assert.equal(stripComments('a /* gone */ b'), 'a  b');

	// An unterminated opener consumes the rest, which is what a parser does too.
	assert.equal(stripComments('ok <!-- never closed {@html x}'), 'ok ');
});

test('contentus owns no client-side rendering of a message body', () => {
	// The invariant the disclosure exists to protect. Escaping is upstream's
	// defect; the fix is upstream's too, and contentus must not have quietly
	// grown a second renderer while waiting for it.
	for (const file of [
		'src/lib/messaging/MessagingSurface.svelte',
		'src/lib/messaging/ConversationList.svelte',
		'src/lib/messaging/contract.ts',
		'src/lib/messaging/handlers.ts',
		'src/lib/messaging/adapter.ts',
	]) {
		// Comments are stripped first, to a FIXED POINT, the same way
		// `audit-renderer-authority.mjs` does it. These files EXPLAIN the
		// `{@html}` rule in prose, and a probe that failed on the explanation
		// would be measuring its own documentation rather than its code.
		const source = stripComments(readFileSync(file, 'utf8'));

		assert.ok(!/\{@html\b/.test(source), `${file} contains an {@html} sink`);
		assert.ok(
			!/innerHTML/.test(source),
			`${file} writes innerHTML — rendering authority is lesser's`
		);
	}
});
