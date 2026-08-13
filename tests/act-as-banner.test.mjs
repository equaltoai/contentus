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
});
