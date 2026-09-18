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
 * THE DETAIL SEAM IS NOT ONLY THE PUBLIC HALF. It also owns the owner's two
 * panels and the client-only gate that mounts them, moved off the roster seam by
 * equaltoai/contentus#119 — see the comment on that `owns` list for the argument
 * this file used to make the other way, and why it stopped holding. A seam's
 * declaration is a statement about what a swap takes with it, not about which
 * viewers may see it: replacing `AgentDetail.svelte` replaces the owner's grant
 * ledger and activity log too, and saying so is what keeps them from being
 * orphaned by that swap.
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
			'AgentRosterFilters.svelte',
			'AgentSharedWithMePanel.svelte',
			'MyAgents.svelte',
		],
		nests: [],
	},
	'AgentDetail.svelte': {
		owns: [
			'AgentCapabilities.svelte',
			// The owner's two panels and the gate that mounts them, moved here from
			// the roster seam in equaltoai/contentus#119. The comment this replaces
			// argued they belonged behind `AgentRoster.svelte` because `MyAgents`
			// mounted them per owned agent, and said in terms that they could not
			// move: "the detail route has no owner-only surface to mount it on".
			// That was true of the route's ANONYMOUS server paint, which is what it
			// was read as — and it is why the move needed `AgentOwnerPanels.svelte`,
			// a client-only component that asks lesser the ownership question the
			// server pass structurally cannot answer. The detail page has an
			// owner-only surface now, and it is the right home: these are per-agent
			// reads, so they belong on the per-agent page a human navigates to, not
			// on a list that eagerly issued two of them for every agent the viewer
			// owned.
			//
			// Still not a seam of its own, for the reason that has not changed:
			// there is no greater component in prospect that would replace an
			// owner's grant ledger or activity log independently of the page that
			// arranges them.
			'AgentDriversPanel.svelte',
			'AgentOwnerPanels.svelte',
			'AgentSharingPanel.svelte',
			'AgentTrustDetail.svelte',
		],
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
