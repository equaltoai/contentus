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

/**
 * THE ONLY AUTHORITY THAT CAN ANSWER THIS QUESTION.
 *
 * Dereferencing the pin proved the bytes came from *somewhere*; it did not prove
 * they came from lesser. The review demonstrated the gap directly: supply
 * fabricated SDL, compute its length, sha256 and blob OID honestly, publish it at
 * `https://github.com/attacker/fabricated-lesser@aaaa…:schema.graphql`, and every
 * comparison in this module agrees — because every comparison was between the pin
 * and the place the pin chose. A verifier that lets the value under test select
 * its own examiner is not a verifier.
 *
 * So the repository, the path and the host are NOT pin fields any more. They are
 * these constants. The pin still declares them, and a pin declaring anything else
 * is a finding, but the request itself is built from here — an edit to
 * `provenance.json` cannot move the question to a repository that would answer it
 * differently. `ref` stays a pin field because that is the one value a legitimate
 * pin bump moves; it remains constrained to an immutable commit id and is still
 * dereferenced.
 *
 * `upstream_path` is canonical for the same reason a repository is: lesser
 * publishes its contract at one path, and a pin naming `docs/contracts/anything-
 * else.graphql` is either a mistake or a redirection. Both fail here.
 */
export const CANONICAL_SCHEMA_AUTHORITY = Object.freeze({
	host: 'github.com',
	owner: 'equaltoai',
	repo: 'lesser',
	repository: 'https://github.com/equaltoai/lesser',
	upstream_path: 'docs/contracts/graphql-schema.graphql',
	api: 'https://api.github.com',
});

/** The one API prefix this verifier is ever allowed to talk to. */
export const CANONICAL_API_PREFIX = `${CANONICAL_SCHEMA_AUTHORITY.api}/repos/${CANONICAL_SCHEMA_AUTHORITY.owner}/${CANONICAL_SCHEMA_AUTHORITY.repo}/`;

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
 * Does this pin name the one authority allowed to answer the provenance question?
 *
 * Checked OFFLINE as well as online, deliberately. The online verifier no longer
 * builds its request from these fields, so a wrong repository cannot redirect the
 * check — but a pin that *claims* a different upstream while the check silently
 * asks the canonical one would be a document saying something the gate does not
 * enforce, which is the shape of every defect in this milestone. Both must agree,
 * and the offline gate is where a reader first sees them disagree.
 */
export function checkCanonicalAuthority(pin) {
	const findings = [];
	const canonical = CANONICAL_SCHEMA_AUTHORITY;

	const repository = parseGitHubRepository(pin?.repository);
	if (!repository) {
		findings.push(
			`the schema pin's repository \`${pin?.repository}\` is not a https://${canonical.host}/<owner>/<repo> ` +
				'URL. This value is checked against the canonical authority, so it is restricted ' +
				'rather than free text.'
		);
	} else if (repository.owner !== canonical.owner || repository.repo !== canonical.repo) {
		findings.push(
			`the schema pin names ${repository.owner}/${repository.repo} as the upstream authority; ` +
				`the only repository that can answer what lesser published is ${canonical.owner}/${canonical.repo}.`,
			'  A repository containing byte-identical, self-consistent SDL is not evidence: any',
			'  author can create one. Provenance is a claim about WHOSE contract this is, and the',
			'  answer cannot be selected by the value under test.'
		);
	}

	if (pin?.upstream_path !== canonical.upstream_path) {
		findings.push(
			`the schema pin names \`${pin?.upstream_path}\` as the upstream path; lesser publishes ` +
				`its canonical contract at \`${canonical.upstream_path}\`.`,
			'  An alternate path inside the right repository is the same substitution as the wrong',
			'  repository, one level down: it lets a file nobody reviews stand in for the contract.'
		);
	}

	return findings;
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
	findings.push(...checkCanonicalAuthority(pin));

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

	// BUILT FROM THE CONSTANT, NOT FROM THE PIN. `checkPinIntegrity` above already
	// refused a pin naming anything else, so these agree — but they are read from
	// here so that even a caller who skipped that check, or a future edit that
	// loosened it, still asks lesser rather than whoever the pin nominated.
	const canonical = CANONICAL_SCHEMA_AUTHORITY;
	const api = `${canonical.api}/repos/${canonical.owner}/${canonical.repo}`;
	const headers = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
		'user-agent': 'contentus-schema-provenance',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};

	const get = async (url, what) => {
		// The last place a URL could stop naming the canonical authority is here, so
		// it is checked here rather than trusted from construction. A verifier that
		// talks to one host and reports about another is worse than no verifier.
		if (!url.startsWith(CANONICAL_API_PREFIX)) {
			findings.push(
				`refusing to dereference ${url}: this verifier may only ask ${CANONICAL_API_PREFIX}. ` +
					'A provenance check that can be pointed elsewhere is answering a different question.'
			);
			return null;
		}

		let response;
		try {
			// `redirect: 'error'` rather than the default follow. A 3xx is the API
			// telling us the object lives somewhere else, and "somewhere else" is
			// exactly the ambiguity this gate exists to remove: a followed redirect
			// would let a renamed or transferred repository answer for lesser without
			// anything in the output saying so.
			response = await fetchImpl(url, { headers, redirect: 'error' });
		} catch (error) {
			findings.push(
				`could not reach GitHub for ${what}: ${error?.message ?? error}. An unreachable ` +
					'upstream is an unverified pin, never a passing one.'
			);
			return null;
		}
		// A stub, a proxy, or an implementation that follows redirects regardless can
		// still hand back a response whose final URL is not the one asked for.
		if (
			response?.redirected === true ||
			(response?.url && !response.url.startsWith(CANONICAL_API_PREFIX))
		) {
			findings.push(
				`${what} was answered from ${response.url ?? 'a redirected location'} rather than ` +
					`${url}. A redirected answer names an object this gate did not ask for.`
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
		`lesser commit ${pin.ref} in ${canonical.repository}`
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
		`${api}/contents/${encodeURI(canonical.upstream_path)}?ref=${pin.ref}`,
		`${canonical.upstream_path} at ${pin.ref} in ${canonical.repository}`
	);
	if (!contents) return { findings, observed };

	if (contents.type !== 'file' || typeof contents.sha !== 'string') {
		findings.push(
			`${canonical.upstream_path} at ${pin.ref} is not a file (type ${contents.type ?? 'unknown'}).`
		);
		return { findings, observed };
	}
	observed.upstream_blob = contents.sha;

	if (contents.sha !== pin.git_blob_sha1) {
		findings.push(
			`the git object upstream does not match the pinned bytes.`,
			`  ${canonical.repository}@${pin.ref}:${canonical.upstream_path}`,
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
			`${canonical.upstream_path} came back with encoding ${contents.encoding ?? 'none'}; this check ` +
				'compares bytes, so an undecodable body is a failure rather than a shortcut to the ' +
				'blob id alone.'
		);
		return { findings, observed };
	}

	const upstreamBytes = Buffer.from(contents.content, 'base64');
	const upstreamOid = gitBlobOid(upstreamBytes);
	if (upstreamOid !== contents.sha) {
		findings.push(
			`GitHub returned content for ${canonical.upstream_path} that does not hash to the blob id it ` +
				`reported (${upstreamOid} vs ${contents.sha}). The response is not internally ` +
				'consistent and is not evidence.'
		);
		return { findings, observed };
	}
	if (!upstreamBytes.equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
		findings.push(
			`${pin.pinned_path} differs from ${canonical.upstream_path} at ${pin.ref} byte for byte, ` +
				'despite matching blob ids. Treat this as a broken invariant, not a near miss.'
		);
		return { findings, observed };
	}

	observed.bytes = upstreamBytes.length;
	observed.sha256 = sha256(upstreamBytes);
	return { findings, observed };
}
