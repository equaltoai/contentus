import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { auditAllSeams } from '../scripts/audit-seam-graph.mjs';

test('the M7 roster and creation workspaces are build-verified swap seams', async () => {
	const baseline = await auditAllSeams();
	assert.deepEqual(baseline.findings, []);
});

test('the build graph rejects a creation component reaching behind the roster seam', async () => {
	const path = 'src/lib/drones/DroneCreationForm.svelte';
	const source = readFileSync(path, 'utf8').replace(
		'</script>',
		"\timport DroneCard from './DroneCard.svelte';\n</script>"
	);
	const result = await auditAllSeams({ overlay: { [path]: source } });

	assert.ok(
		result.findings.some(
			(finding) =>
				finding ===
				'src/lib/drones/DroneCreationForm.svelte → src/lib/drones/DroneCard.svelte (owned by DroneRoster.svelte, imported from DroneCreationFlow.svelte)'
		),
		result.findings.join('\n')
	);
});
