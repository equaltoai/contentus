/**
 * Face 6's swap seams, declared ONCE for every check that asserts them.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE CHECKS. The declaration used to live
 * inside `tests/agents-mobile.test.mjs`, which was the only thing that read it.
 * A second reader now exists — `scripts/audit-seam-graph.mjs` derives the same
 * property from the build's own module resolution — and two copies of a graph is
 * how the second copy keeps passing after the first is corrected. So the graph is
 * stated here, the checks import it, and a seam added in one place is a seam
 * every check sees.
 *
 * THREE SEAMS, NOT TWO. The docs said two — the roster and the MCP panel — and
 * the detail route imports neither: it imports `AgentDetail.svelte`, which
 * composes the identity header, the trust detail and the capability list, and
 * nests the MCP seam inside itself. That is a third replaceable boundary, and an
 * undeclared boundary is the one nobody checks. It is named here and in
 * `docs/consumption/agent-contract.md` rather than dissolved, because the detail
 * page genuinely has a component-shaped middle: greater M6a is expected to land
 * the roster and the MCP detail separately, and the page that arranges them is
 * contentus's until it does.
 *
 * `owns` is what a seam takes with it when it is replaced. `nests` is a seam
 * composed by another seam — the only cross-seam import that is not a defect,
 * because it is the one that keeps the MCP panel independently swappable.
 * `SHARED` is imported from more than one seam by design: `AgentTrustBadge` is
 * the one pill both the roster card and the detail header show, and greater's
 * `AgentStateBadge` replaces it on both at once.
 */

/** The face's directory, repository-relative, with no trailing slash. */
export const FACE_DIR = 'src/lib/agents';

export const SEAMS = {
	'AgentRoster.svelte': {
		owns: [
			'AgentCard.svelte',
			// The owner's "who has been driving" view (M2.4,
			// equaltoai/contentus#95) sits behind this seam for the same reason
			// `AgentSharingPanel` does: `MyAgents` mounts it per owned agent, so a
			// swap that replaces the roster orphans it. It is not SHARED — the
			// detail route has no owner-only surface to mount it on — and it is not
			// a seam of its own, because there is no greater component in prospect
			// that would replace an activity-log view independently of the roster
			// that carries it.
			'AgentDriversPanel.svelte',
			'AgentRosterFilters.svelte',
			'AgentSharedWithMePanel.svelte',
			'AgentSharingPanel.svelte',
			'MyAgents.svelte',
		],
		nests: [],
	},
	'AgentDetail.svelte': {
		owns: ['AgentCapabilities.svelte', 'AgentTrustDetail.svelte'],
		nests: ['AgentMcpPanel.svelte'],
	},
	'AgentMcpPanel.svelte': {
		owns: ['Accordion.svelte', 'CopyBlock.svelte'],
		nests: [],
	},
};

export const SHARED = ['AgentTrustBadge.svelte'];

/** Every component the declaration names, in the one place it names it. */
export const DECLARED = [
	...Object.keys(SEAMS),
	...Object.values(SEAMS).flatMap((seam) => seam.owns),
	...SHARED,
];

/** Which seam a component belongs to, or null if it is not behind one. */
export function ownerOf(name) {
	for (const [seam, { owns }] of Object.entries(SEAMS)) if (owns.includes(name)) return seam;
	return null;
}

/**
 * The name a repository-relative path has inside the face, or null when the path
 * is outside it.
 *
 * A file in a SUBDIRECTORY of the face returns its whole remainder rather than
 * its basename — `sub/X.svelte`, which no declaration names, so it is a finding
 * rather than a file that quietly answers to a declared name. The face is flat
 * today and this is what happens on the day it is not.
 */
export function faceName(path) {
	if (!path.startsWith(`${FACE_DIR}/`)) return null;
	return path.slice(FACE_DIR.length + 1) || null;
}

const isComponent = (name) => name.endsWith('.svelte');

/**
 * Why an edge from `importer` to `target` breaks the seams, or null when it does
 * not. Both are repository-relative paths.
 *
 * THE RULES, stated in one place because every check is meant to be asking the
 * same question:
 *
 *   - An edge whose target is outside the face is not a seam question at all.
 *   - A non-component file inside the face — `contract.ts`, `filters.ts`,
 *     `mcp.ts` — is what SURVIVES a swap, so anything may depend on it. Its own
 *     outgoing edges are judged like any other importer's, which is what stops a
 *     barrel laundering a component through it.
 *   - From OUTSIDE the face, a seam is the only component that may be imported.
 *     Everything behind one is orphaned by the swap that replaces it.
 *   - From INSIDE, a component owned by a seam may be imported by that seam and
 *     by its siblings, a seam may compose another seam only where the nesting is
 *     declared, and a shared component may be imported anywhere.
 *   - A component no declaration names is a finding in every direction: either it
 *     was added without a decision about which seam takes it, or the graph moved
 *     under the check.
 */
export function seamOffence(importer, target) {
	const targetName = faceName(target);
	if (!targetName || !isComponent(targetName)) return null;
	if (importer === target) return null;

	const importerName = faceName(importer);
	const declared = DECLARED.includes(targetName);

	if (importerName === null) {
		if (!declared)
			return `${importer} → ${target} (a component in the face that no seam declaration names)`;
		if (targetName in SEAMS) return null;
		if (SHARED.includes(targetName))
			return `${importer} → ${target} (shared between seams, imported from outside the face)`;
		return `${importer} → ${target} (behind ${ownerOf(targetName)}, imported from outside the face)`;
	}

	if (!declared)
		return `${importer} → ${target} (a component in the face that no seam declaration names)`;
	if (SHARED.includes(targetName)) return null;

	const importerSeam = importerName in SEAMS ? importerName : ownerOf(importerName);

	if (targetName in SEAMS) {
		if (importerSeam && SEAMS[importerSeam].nests.includes(targetName)) return null;
		return importerSeam
			? `${importer} → ${target} (an undeclared seam-to-seam import)`
			: `${importer} → ${target} (a seam imported from behind no seam)`;
	}

	const owner = ownerOf(targetName);
	if (owner === importerSeam) return null;
	return `${importer} → ${target} (owned by ${owner}, imported from ${importerSeam ?? 'behind no seam'})`;
}
