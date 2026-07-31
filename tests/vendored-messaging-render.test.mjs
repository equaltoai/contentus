/**
 * The vendored messaging suite's rendering gap, pinned.
 *
 * THE DEFECT. lesser's `Object.content` is server-sanitized HTML — that is the
 * renderer-authority contract, and every other contentus surface treats it as
 * such. greater's `Messages.Message` renders it with `{message.content}`,
 * Svelte's ESCAPING interpolation, so a message body arrives in the DOM as its
 * own markup shown as literal text:
 *
 *   lesser sends  <p>Hello <strong>world</strong></p>
 *   reader sees   <p>Hello <strong>world</strong></p>   (as text)
 *
 * `Messages.Conversations` does the same to the list preview. Same family as
 * the `ContentRenderer` gap M4 pinned, in a different component.
 *
 * WHY CONTENTUS DOES NOT FIX IT. Vendored source is never hand-edited; an
 * `{@html}` in owned source is what check 3 of `audit-renderer-authority.mjs`
 * forbids; and the component exposes no prop, snippet or child that changes the
 * sink. So the gap is DISCLOSED in the surface (`MessagingSurface.svelte`
 * renders the notice unconditionally) and routed upstream.
 *
 * WHY THIS PROBE IS SHAPED THE WAY IT IS. M4 cost a review round on exactly
 * this: a probe that REPRODUCES the pipeline in test code agrees with itself no
 * matter what the vendored file says, so upstream could fix the component and
 * the probe would stay green while the disclosure went on claiming a defect
 * that no longer existed. So this compiles the REAL vendored component with the
 * REAL Svelte compiler and asserts on the sink the compiler emitted, and runs
 * the REAL `escape` from `svelte/internal/server` to show the consequence.
 *
 * EVERY ASSERTION IS INVERTED — it describes the BROKEN behaviour and fails the
 * day upstream fixes it. That is deliberate. When it goes red, the fix is to
 * delete the disclosure in `MessagingSurface.svelte`, the note in
 * `docs/consumption/messaging-contract.md`, and this file.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compile } from 'svelte/compiler';
import { escape } from 'svelte/internal/server';

/** Compile a vendored component exactly as the build does for the server pass. */
function compileServer(path) {
	const source = readFileSync(path, 'utf8');
	return compile(source, { generate: 'server', name: 'Probe' }).js.code;
}

const MESSAGE = 'src/lib/components/messaging/Message.svelte';
const CONVERSATIONS = 'src/lib/components/messaging/Conversations.svelte';

/** A body in the shape lesser's sanitizer actually emits. */
const SANITIZED = '<p>Hello <strong>world</strong></p>';

test('the vendored message body is emitted through the escaping sink', () => {
	const code = compileServer(MESSAGE);

	// The compiler's own output, not a reading of the template. `{expr}` compiles
	// to `$.escape(expr)`; `{@html expr}` compiles to a raw push. Finding the
	// former around `message.content` IS the defect.
	const contentDiv = code.match(/message__content"[^`]*?\$\.escape\(([^)]*)\)/);
	assert.ok(
		contentDiv,
		'the message body is no longer emitted through $.escape — upstream may have fixed this; ' +
			'delete the disclosure in MessagingSurface.svelte and this file'
	);
	assert.match(
		contentDiv[1],
		/message\.content/,
		'the escaped expression next to message__content is not the body'
	);

	// And the other half of the claim: there is no raw sink anywhere in the
	// component, so no branch renders the body correctly.
	assert.ok(
		!/\$\.html\(/.test(code),
		'the component now has a raw HTML sink — check whether the body path uses it'
	);
});

test('the vendored conversation preview escapes the body too', () => {
	const code = compileServer(CONVERSATIONS);

	// The list preview reads `message.content` through `getMessagePreview`, which
	// returns it unchanged, and renders it with `{...}`. Pinned separately
	// because it is a second surface a reader meets before opening anything —
	// M4's lesson that a gap must be pinned on EVERY surface it reaches, not the
	// first one found.
	assert.ok(
		/\$\.escape\(getMessagePreview\(/.test(code),
		'the conversation preview no longer escapes the body — re-check the disclosure'
	);
	assert.ok(!/\$\.html\(/.test(code), 'the conversation list now has a raw HTML sink');
});

test('escaping a sanitized body produces literal markup for the reader', () => {
	// The real `escape` from Svelte's server runtime — the exact function the
	// compiled component calls. This is the consequence of the two assertions
	// above, demonstrated rather than described.
	const rendered = escape(SANITIZED);

	// Svelte escapes `<` and `&` and leaves `>` alone — that is enough to stop an
	// element being parsed, which is why the body becomes visible text. The exact
	// output is asserted rather than a paraphrase of it, so a change in Svelte's
	// escaping is a red probe rather than a silently different screen.
	assert.equal(
		rendered,
		'&lt;p>Hello &lt;strong>world&lt;/strong>&lt;/p>',
		'Svelte no longer escapes this input the same way — re-check the disclosure'
	);

	// What that means on screen: the tags are visible text, and the emphasis
	// lesser applied is gone.
	assert.ok(rendered.includes('&lt;strong>'), 'the markup should be shown rather than applied');
	assert.ok(!rendered.includes('<strong>'), 'no element is produced from the sanitized body');
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

test('contentus discloses the gap unconditionally, not only when a message exists', () => {
	const surface = readFileSync('src/lib/messaging/MessagingSurface.svelte', 'utf8');

	// A disclosure gated on having messages would never reach the reader whose
	// inbox is empty today and receives one tomorrow. The notice sits outside
	// every `{#if}` in the template, which is what "always rendered" means here.
	const notice = 'contentus-messages__gap';
	assert.ok(surface.includes(notice), 'the renderer-authority disclosure is missing');

	const template = surface.slice(surface.indexOf('</script>'));
	const before = template.slice(0, template.indexOf(notice));
	// Every block opened before the notice must also be closed before it.
	const opened = (before.match(/\{#(if|each|key)\b/g) ?? []).length;
	const closed = (before.match(/\{\/(if|each|key)\}/g) ?? []).length;
	assert.equal(
		opened,
		closed,
		'the disclosure sits inside a conditional — it must render for every reader on this surface'
	);
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
		// Comments are stripped first, the same way `audit-renderer-authority.mjs`
		// does it. These files EXPLAIN the `{@html}` rule in prose, and a probe
		// that failed on the explanation would be measuring its own documentation
		// rather than its code.
		const source = readFileSync(file, 'utf8')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');

		assert.ok(!/\{@html\b/.test(source), `${file} contains an {@html} sink`);
		assert.ok(
			!/innerHTML/.test(source),
			`${file} writes innerHTML — rendering authority is lesser's`
		);
	}
});
