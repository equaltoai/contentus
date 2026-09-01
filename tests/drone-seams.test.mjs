import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { auditAllSeams } from '../scripts/audit-seam-graph.mjs';
import { withSourceLock } from './helpers/source-lock.mjs';

// Both runs below build the REAL tree (vite, in-memory). Locked against the
// mutators — the renderer-authority and release-binding probes plant fixtures
// over real files while they audit them, and a build must never resolve a
// fixture over the shipped file. Shared, so these builds run alongside the
// other reader builds and only exclude the mutation windows.
const audit = async (overlay = {}) =>
	withSourceLock(() => auditAllSeams({ overlay }), { shared: true });

test('the M7 roster and creation workspaces are build-verified swap seams', async () => {
	const baseline = await audit();
	assert.deepEqual(baseline.findings, []);
});

test('the build graph rejects a creation component reaching behind the roster seam', async () => {
	const path = 'src/lib/drones/DroneCreationForm.svelte';
	const source = readFileSync(path, 'utf8').replace(
		'</script>',
		"\timport DroneCard from './DroneCard.svelte';\n</script>"
	);
	const result = await audit({ [path]: source });

	assert.ok(
		result.findings.some(
			(finding) =>
				finding ===
				'src/lib/drones/DroneCreationForm.svelte → src/lib/drones/DroneCard.svelte (owned by DroneRoster.svelte, imported from DroneCreationFlow.svelte)'
		),
		result.findings.join('\n')
	);
});
