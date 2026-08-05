import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { identitySurfaceHref } from '../src/lib/drones/identity.ts';

test('promotion links leave the Contentus base for simulacrum identity', () => {
	assert.equal(identitySurfaceHref('scout'), '/identity/scout');
	assert.equal(identitySurfaceHref('drone/name'), '/identity/drone%2Fname');

	const card = readFileSync('src/lib/drones/DroneCard.svelte', 'utf8');
	const flow = readFileSync('src/lib/drones/DroneCreationFlow.svelte', 'utf8');
	assert.match(card, /identitySurfaceHref\(drone\.agent\.username\)/);
	assert.match(card, /Open identity &amp; promotion/);
	assert.match(flow, /identitySurfaceHref\(createdUsername\)/);
	assert.doesNotMatch(`${card}\n${flow}`, /soulBootstrap|startSoul|finalizeSoul/);
});

test('the phone creation form stays one field per row with a sticky full-width submit', () => {
	const css = readFileSync('src/lib/brand/drones.css', 'utf8');
	const form = readFileSync('src/lib/drones/DroneCreationForm.svelte', 'utf8');

	assert.match(css, /\.contentus-drone-form\s*{[^}]*grid-template-columns:\s*1fr/s);
	assert.match(css, /\.contentus-drone-form__field\s*{[^}]*grid-template-columns:\s*1fr/s);
	assert.match(css, /\.contentus-drone-form__submit\s*{[^}]*position:\s*sticky/s);
	assert.match(css, /bottom:\s*max\([^;]*safe-area-inset-bottom[^;]*;/s);
	assert.match(
		css,
		/\.contentus-drone-form__submit \.contentus-drone-action\s*{[^}]*width:\s*100%/s
	);
	assert.match(form, /type="submit"/);
	assert.match(form, /Creating drone…/);
});
