/**
 * Face 7's replaceable component seams.
 *
 * The GraphQL contract module survives a future greater-components swap. Route
 * components may import only the two public seams below; everything each seam
 * owns moves with it. This keeps the roster and creation workspace independently
 * replaceable without vendoring greater's soul-genesis face.
 */

export const FACE_DIR = 'src/lib/drones';

export const SEAMS = {
	'DroneRoster.svelte': {
		owns: ['DroneCard.svelte'],
		nests: [],
	},
	'DroneCreationFlow.svelte': {
		owns: ['DroneCreationForm.svelte', 'DroneCredentials.svelte', 'DronePolicyDisabled.svelte'],
		nests: [],
	},
};

export const SHARED = [];
export const DECLARED = [
	...Object.keys(SEAMS),
	...Object.values(SEAMS).flatMap((seam) => seam.owns),
];

export function ownerOf(name) {
	for (const [seam, { owns }] of Object.entries(SEAMS)) if (owns.includes(name)) return seam;
	return null;
}

export function faceName(path) {
	if (!path.startsWith(`${FACE_DIR}/`)) return null;
	return path.slice(FACE_DIR.length + 1) || null;
}

const isComponent = (name) => name.endsWith('.svelte');

export function seamOffence(importer, target) {
	const targetName = faceName(target);
	if (!targetName || !isComponent(targetName) || importer === target) return null;

	const importerName = faceName(importer);
	const declared = DECLARED.includes(targetName);
	if (importerName === null) {
		if (!declared)
			return `${importer} → ${target} (a component in the face that no seam declaration names)`;
		if (targetName in SEAMS) return null;
		return `${importer} → ${target} (behind ${ownerOf(targetName)}, imported from outside the face)`;
	}

	if (!declared)
		return `${importer} → ${target} (a component in the face that no seam declaration names)`;
	const importerSeam = importerName in SEAMS ? importerName : ownerOf(importerName);
	if (targetName in SEAMS) {
		if (importerSeam && SEAMS[importerSeam].nests.includes(targetName)) return null;
		return `${importer} → ${target} (an undeclared seam-to-seam import)`;
	}
	const owner = ownerOf(targetName);
	if (owner === importerSeam) return null;
	return `${importer} → ${target} (owned by ${owner}, imported from ${importerSeam ?? 'behind no seam'})`;
}
