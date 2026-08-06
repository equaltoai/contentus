/**
 * The pinned lesser schema, and what it takes to believe it came from lesser.
 *
 * TWO CHECKS THAT ARE NOT THE SAME CHECK, and the whole point of this module is
 * keeping them apart.
 *
 * 1. INTEGRITY, offline and deterministic. The bytes in the tree hash to the
 *    digest, the byte count, and the GIT BLOB OID recorded beside them. This runs
 *    on every build, needs no network, and answers "are these the bytes this
 *    repository pinned?".
 *
 * 2. PROVENANCE, online and separately trusted. The declared repository, commit
 *    and path are DEREFERENCED against GitHub, and the git object living there is
 *    compared with the bytes in the tree. This answers a different question —
 *    "did lesser actually publish these bytes, at that commit, at that path?" —
 *    and offline integrity cannot answer it at all.
 *
 * WHY THE SEPARATION IS THE FIX. The previous gate hashed the checked-in schema
 * and compared it with a digest checked in beside it, both editable in the same
 * commit. Two co-edited local values agreeing with each other is not evidence
 * about an upstream repository: an author who fabricates a schema and updates the
 * digest produces a locally self-consistent tree that passes, while still
 * claiming lesser `e710ff…`. The adversarial review demonstrated exactly that,
 * and also that changing `ref` to forty `f` characters left the gate green,
 * because nothing ever dereferenced the ref.
 *
 * THE BINDING THAT CLOSES IT is git's own content addressing. A blob's OID is
 * `sha1("blob " + length + "\0" + bytes)` — a pure function of the bytes. So the
 * OID computed from the local file is directly comparable with the OID GitHub
 * reports for `<repository>@<ref>:<upstream_path>`, with no trust in any local
 * value in between. Fabricate the schema and the OID moves; point at the wrong
 * repository, ref or path and the dereference 404s or answers a different OID;
 * let the schema go stale and upstream's OID no longer matches. None of those
 * can be repaired by editing another field in this repository, which is what
 * makes it a binding rather than a restatement.
 *
 * WHAT OFFLINE INTEGRITY MUST NEVER CLAIM. That the pin is authentic. It claims
 * the bytes are unchanged since someone wrote the digest down, and nothing more.
 * Callers say so in those words; `scripts/verify-schema-provenance.mjs` is the
 * mechanism that makes the stronger claim, and it must run in CI for the stronger
 * claim to be available at all.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Fields a schema pin must carry before either check can run. */
export const REQUIRED_SCHEMA_PIN_FIELDS = [
	'repository',
	'ref',
	'upstream_path',
	'pinned_path',
	'sha256',
	'bytes',
	'git_blob_sha1',
];

/**
 * Read a provenance pin, rejecting duplicate keys.
 *
 * `JSON.parse` is last-wins, so a repeated key is one value a reviewer reads and
 * a different value this gate enforces. That is the shape of a pin that has
 * quietly stopped asserting what it appears to assert.
 */
export function readPin(root, file) {
	const text = readFileSync(path.join(root, file), 'utf8');
	const duplicates = duplicateKeys(text);
	if (duplicates.length) {
		throw new Error(`${file} has duplicate keys: ${duplicates.join(', ')}`);
	}
	return JSON.parse(text);
}

/** Duplicate keys within any single object, found by re-walking the token stream. */
export function duplicateKeys(text) {
	const found = new Set();
	const stack = [new Set()];
	const tokens = /"((?:[^"\\]|\\.)*)"\s*:|([{[])|([}\]])/g;
	for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
		if (match[2]) stack.push(new Set());
		else if (match[3]) stack.pop();
		else if (match[1] !== undefined) {
			const scope = stack[stack.length - 1];
			if (scope.has(match[1])) found.add(match[1]);
			scope.add(match[1]);
		}
	}
	return [...found];
}

export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The git blob OID of these bytes — `sha1("blob " + length + "\0" + bytes)`.
 *
 * This is the value git itself stores the file under, so it is directly
 * comparable with the `sha` GitHub reports for a path at a commit. Computing it
 * here rather than shelling out to `git hash-object` keeps the check available
 * on a checkout with no git binary, and keeps it a pure function of the bytes.
 */
export function gitBlobOid(bytes) {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
	return createHash('sha1')
		.update(Buffer.concat([header, buffer]))
		.digest('hex');
}

/** A 40-character lowercase hex commit id — the only ref form that is immutable. */
export function isCommitId(value) {
	return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * `https://github.com/<owner>/<repo>` and nothing else.
 *
 * Strict because this value chooses the HOST the verifier talks to. A pin that
 * could name any origin would let the "upstream" check be answered by whoever
 * wrote the pin, which is the failure this whole module exists to remove.
 */
export function parseGitHubRepository(url) {
	if (typeof url !== 'string') return null;
	// Bounded before it reaches a pattern with a lazy quantifier. The value is
	// repository-controlled today, but a length cap costs nothing and keeps this
	// from being the one input where that assumption has to hold.
	if (url.length > 512) return null;
	const match = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
		url
	);
	if (!match) return null;
	const [, owner, repo] = match;
	if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
	return { owner, repo };
}

/**
 * Offline integrity: do the bytes in the tree match every value pinned beside
 * them? Returns findings; empty means the bytes are what this repository says
 * they are, which is NOT the same as saying they are what lesser published.
 */
export function checkPinIntegrity(pin, bytes) {
	const findings = [];

	for (const field of REQUIRED_SCHEMA_PIN_FIELDS) {
		if (pin?.[field] === undefined || pin[field] === null || pin[field] === '') {
			findings.push(
				`the schema pin is missing \`${field}\`. Every field is load-bearing: the gate ` +
					'cannot check a value that was not declared, and a missing field must not read ' +
					'as a satisfied one.'
			);
		}
	}
	if (findings.length) return findings;

	if (!isCommitId(pin.ref)) {
		findings.push(
			`the schema pin's ref \`${pin.ref}\` is not a 40-character lowercase hex commit id. ` +
				'A branch or tag is a moving target; only a commit id names bytes that cannot change ' +
				'underneath the pin.'
		);
	}
	if (!parseGitHubRepository(pin.repository)) {
		findings.push(
			`the schema pin's repository \`${pin.repository}\` is not a https://github.com/<owner>/<repo> ` +
				'URL. This value selects the host the provenance verifier dereferences, so it is ' +
				'restricted rather than free text.'
		);
	}

	const digest = sha256(bytes);
	if (digest !== pin.sha256) {
		findings.push(
			`${pin.pinned_path} does not match its pinned sha256.`,
			`  recorded ${pin.sha256}`,
			`  actual   ${digest}`
		);
	}
	if (bytes.length !== pin.bytes) {
		findings.push(`${pin.pinned_path} is ${bytes.length} bytes; the pin records ${pin.bytes}`);
	}

	const oid = gitBlobOid(bytes);
	if (oid !== pin.git_blob_sha1) {
		findings.push(
			`${pin.pinned_path} does not hash to its pinned git blob OID.`,
			`  recorded ${pin.git_blob_sha1}`,
			`  actual   ${oid}`,
			'  This OID is the value the upstream check compares against lesser, so a tree where ' +
				'it drifts cannot be authenticated at all.'
		);
	}

	return findings;
}

/**
 * Online provenance: dereference the declared repository, commit and path, and
 * compare the git object living there with the bytes in this tree.
 *
 * `fetchImpl` is injected so the tests can drive every failure direction —
 * missing commit, wrong repository, wrong path, upstream bytes that differ —
 * deterministically and without network. In CI it is the real `fetch`, reaching
 * GitHub, which is what makes this mechanism separately trusted: it is answered
 * by the upstream repository rather than by a second value in this one.
 *
 * FAILS CLOSED IN EVERY DIRECTION. A network error, a non-200, a body that is
 * not the expected shape, an unexpected encoding, and every mismatch are all
 * findings. "I could not reach GitHub" must never read as "GitHub agreed".
 */
export async function verifyUpstreamObject({ pin, bytes, fetchImpl, token = null }) {
	const findings = [];
	const observed = {};

	const integrity = checkPinIntegrity(pin, bytes);
	if (integrity.length) return { findings: integrity, observed };

	const repository = parseGitHubRepository(pin.repository);
	const api = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
	const headers = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
		'user-agent': 'contentus-schema-provenance',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};

	const get = async (url, what) => {
		let response;
		try {
			response = await fetchImpl(url, { headers });
		} catch (error) {
			findings.push(
				`could not reach GitHub for ${what}: ${error?.message ?? error}. An unreachable ` +
					'upstream is an unverified pin, never a passing one.'
			);
			return null;
		}
		if (!response || response.ok !== true) {
			findings.push(
				`${what} could not be dereferenced (HTTP ${response?.status ?? 'unknown'}). ` +
					`Checked ${url}. A ref, repository or path that does not resolve is a pin that ` +
					'names something upstream does not have.'
			);
			return null;
		}
		try {
			return await response.json();
		} catch (error) {
			findings.push(`${what} did not return JSON: ${error?.message ?? error}`);
			return null;
		}
	};

	// --- the commit object: does this ref exist in the declared repository? ----
	const commit = await get(
		`${api}/git/commits/${pin.ref}`,
		`lesser commit ${pin.ref} in ${pin.repository}`
	);
	if (!commit) return { findings, observed };
	if (commit.sha !== pin.ref) {
		findings.push(
			`the commit object returned for ${pin.ref} reports sha ${commit.sha}. The pin does not ` +
				'name the object GitHub resolved.'
		);
		return { findings, observed };
	}
	observed.commit = commit.sha;

	// --- the blob at that path, in that commit -------------------------------
	const contents = await get(
		`${api}/contents/${encodeURI(pin.upstream_path)}?ref=${pin.ref}`,
		`${pin.upstream_path} at ${pin.ref} in ${pin.repository}`
	);
	if (!contents) return { findings, observed };

	if (contents.type !== 'file' || typeof contents.sha !== 'string') {
		findings.push(
			`${pin.upstream_path} at ${pin.ref} is not a file (type ${contents.type ?? 'unknown'}).`
		);
		return { findings, observed };
	}
	observed.upstream_blob = contents.sha;

	if (contents.sha !== pin.git_blob_sha1) {
		findings.push(
			`the git object upstream does not match the pinned bytes.`,
			`  ${pin.repository}@${pin.ref}:${pin.upstream_path}`,
			`  upstream blob ${contents.sha}`,
			`  pinned   blob ${pin.git_blob_sha1}`,
			'  The bytes in contracts/ are not the bytes lesser published at this ref. Either the ' +
				'pinned schema was fabricated or edited, or the ref/path names a different object.'
		);
		return { findings, observed };
	}

	// --- and the bytes themselves, not just their name ------------------------
	if (contents.encoding !== 'base64' || typeof contents.content !== 'string') {
		findings.push(
			`${pin.upstream_path} came back with encoding ${contents.encoding ?? 'none'}; this check ` +
				'compares bytes, so an undecodable body is a failure rather than a shortcut to the ' +
				'blob id alone.'
		);
		return { findings, observed };
	}

	const upstreamBytes = Buffer.from(contents.content, 'base64');
	const upstreamOid = gitBlobOid(upstreamBytes);
	if (upstreamOid !== contents.sha) {
		findings.push(
			`GitHub returned content for ${pin.upstream_path} that does not hash to the blob id it ` +
				`reported (${upstreamOid} vs ${contents.sha}). The response is not internally ` +
				'consistent and is not evidence.'
		);
		return { findings, observed };
	}
	if (!upstreamBytes.equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
		findings.push(
			`${pin.pinned_path} differs from ${pin.upstream_path} at ${pin.ref} byte for byte, ` +
				'despite matching blob ids. Treat this as a broken invariant, not a near miss.'
		);
		return { findings, observed };
	}

	observed.bytes = upstreamBytes.length;
	observed.sha256 = sha256(upstreamBytes);
	return { findings, observed };
}
