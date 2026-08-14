import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parse } from 'svelte/compiler';

/**
 * The act-as banner (M7.0, item 9), checked structurally.
 *
 * The banner is the review surfaces' legibility mechanism: when the viewer
 * acts as a shared agent, verdicts and publishes carry the agent in the
 * acting position and the real caller in lesser's attribution position, and
 * the banner is what says so on screen. Its removal would be silent — every
 * other gate stays green — so the mounts and the wiring are the assertions.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = (path) => readFileSync(join(repoRoot, path), 'utf8');

/** Every template node with its ancestor chain, from a parsed markup root. */
function* walkTemplate(node, ancestors = []) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) yield* walkTemplate(item, ancestors);
		return;
	}
	yield { node, ancestors };
	for (const [key, value] of Object.entries(node)) {
		if (key === 'parent' || key === 'loc' || key === 'start' || key === 'end') continue;
		yield* walkTemplate(value, [...ancestors, node]);
	}
}

function* templateNodes(root) {
	for (const { node } of walkTemplate(root)) yield node;
}

/** Whether a parsed program calls `name(...)` anywhere. */
function callsFn(ast, name) {
	for (const { node } of walkTemplate(ast)) {
		if (node.type !== 'CallExpression') continue;
		const callee = node.callee;
		if (callee?.type === 'Identifier' && callee.name === name) return true;
		if (callee?.type === 'MemberExpression' && callee.property?.name === name) return true;
	}
	return false;
}

test('both review surfaces mount the act-as banner', () => {
	// A verdict and a publish are the writes act-as attribution covers, and
	// both happen on these two surfaces. A banner dropped from one of them
	// would leave acting-as silent on exactly the surface that matters.
	for (const file of [
		'src/lib/routes/ReviewQueue.svelte',
		'src/lib/routes/ReviewWorkspace.svelte',
	]) {
		const ast = parse(source(file), { modern: true });
		const mounts = [...templateNodes(ast.fragment)].filter(
			(node) => node.type === 'Component' && node.name === 'ActAsBanner'
		);
		assert.ok(mounts.length >= 1, `${file} must mount ActAsBanner`);
	}
});

test('the banner tracks the selection live, and renders nothing without one', () => {
	const ast = parse(source('src/lib/review/ActAsBanner.svelte'), { modern: true });

	// The subscription is what makes a mid-session revoke — the designed case —
	// take the banner down without a reload.
	assert.ok(
		callsFn(ast.instance, 'onActAsChange'),
		'the banner must hear selection changes, not snapshot at mount'
	);
	assert.ok(callsFn(ast.instance, 'actAsSelection'), 'and read the selection it subscribes to');

	// The render gate: no selection, no banner. Its absence must state nothing.
	const ifs = [...templateNodes(ast.fragment)].filter((node) => node.type === 'IfBlock');
	assert.ok(
		ifs.some((node) => node.test?.type === 'Identifier' && node.test.name === 'selection'),
		'the banner must render behind {#if selection}'
	);
});

/** The mount callback of a parsed component, or null when it never mounts. */
function mountBody(instance) {
	let mounted = null;
	for (const { node } of walkTemplate(instance)) {
		if (node.type !== 'CallExpression') continue;
		if (node.callee?.type !== 'Identifier' || node.callee.name !== 'onMount') continue;
		mounted = node.arguments?.[0] ?? null;
	}
	return mounted;
}

test('the banner ends a stored selection before it reads one', () => {
	// M2.1 (equaltoai/contentus#92) removed the control that elects a selection,
	// so a stored one can only be an earlier build's — and this is the surface
	// that would otherwise announce it to a grantee who loaded `/review`
	// directly, without passing the panel that clears it. WHERE IN THE MOUNT
	// matters, as it does for that panel: after the read, the announcement has
	// already been made.
	const ast = parse(source('src/lib/review/ActAsBanner.svelte'), { modern: true });

	const mounted = mountBody(ast.instance);
	assert.ok(mounted, 'the banner must mount at all');

	const first = mounted.body?.body?.[0];
	assert.equal(
		first?.type,
		'ExpressionStatement',
		'the first thing the mount does must be a call, not a read or a branch'
	);
	assert.equal(
		first.expression?.type === 'CallExpression' && first.expression.callee?.name,
		'clearActAs',
		'and that call must be clearActAs() — unconditional, and before the selection is read'
	);
});

test('the probe can still see a violation', () => {
	// Both directions, on planted sources, so the green above is a result
	// rather than a property of a check that cannot fail.
	const withoutMount = parse(`<script lang="ts"></script>\n<div>no banner here</div>\n`, {
		modern: true,
	});
	assert.equal(
		[...templateNodes(withoutMount.fragment)].filter(
			(node) => node.type === 'Component' && node.name === 'ActAsBanner'
		).length,
		0
	);

	const withoutSubscription = parse(
		`<script lang="ts">\nlet selection = $state(null);\n</script>\n{#if selection}<p>banner</p>{/if}\n`,
		{ modern: true }
	);
	assert.equal(callsFn(withoutSubscription.instance, 'onActAsChange'), false);

	// A banner that reads the stored selection first and clears after would
	// announce an earlier build's selection on its way out. The position is the
	// assertion, so the planted violation is a mount in the wrong order rather
	// than a mount with no clear in it at all.
	const readsBeforeClearing = parse(
		`<script lang="ts">\nonMount(() => {\nselection = actAsSelection();\nclearActAs();\n});\n</script>\n`,
		{ modern: true }
	);
	const planted = mountBody(readsBeforeClearing.instance);
	assert.ok(planted, 'the planted source must mount, or it tests nothing');
	assert.notEqual(
		planted.body?.body?.[0]?.expression?.type === 'CallExpression' &&
			planted.body.body[0].expression.callee?.name,
		'clearActAs'
	);
});
