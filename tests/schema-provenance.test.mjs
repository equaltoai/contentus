import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	checkPinIntegrity,
	gitBlobOid,
	isCommitId,
	parseGitHubRepository,
	readPin,
	sha256,
	verifyUpstreamObject,
} from '../scripts/lib/schema-pin.mjs';

/**
 * PROVENANCE, as distinct from integrity.
 *
 * The adversarial review refuted the previous gate with two full-gate probes, and
 * both are the same defect wearing different clothes: the gate hashed the
 * checked-in schema and compared it with a digest checked in beside it. Two local
 * values agreeing with each other is not a statement about lesser.
 *
 *   1. `schema.ref` changed to forty `f` characters — gate exited 0, reported PASS.
 *   2. `extend type Actor { fabricatedContractField: String }` appended and the
 *      digest/byte count updated to match — gate exited 0, still claiming lesser
 *      `e710ff…`.
 *
 * Neither is reachable by an offline check, and this file does not pretend
 * otherwise. It proves the split instead: `checkPinIntegrity` catches the bytes
 * moving under a stationary pin, `verifyUpstreamObject` catches the pin naming
 * something lesser does not have, and the two together leave no direction where a
 * local edit produces a green claim about upstream.
 *
 * THE UPSTREAM SIDE IS DRIVEN THROUGH AN INJECTED `fetch`. Not to avoid the
 * network — the real call runs in `.github/workflows/schema-provenance.yml` and
 * locally via `pnpm run validate:schema-provenance` — but because a test that
 * needs GitHub to be reachable and correct can only ever prove the happy path.
 * Every failure direction below is a shape GitHub really returns, asserted
 * deterministically.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const PIN = readPin(REPO, 'contracts/lesser/provenance.json').schema;
const BYTES = readFileSync(join(REPO, PIN.pinned_path));

/** A GitHub whose answers are whatever the case says they are. */
function githubReturning({ commit, contents }) {
	return async (url) => {
		const answer = url.includes('/git/commits/') ? commit : contents;
		if (typeof answer === 'function') return answer(url);
		if (!answer) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => answer };
	};
}

/** The honest upstream: the real bytes, under their real blob id. */
function honestGitHub(bytes = BYTES, ref = PIN.ref) {
	return githubReturning({
		commit: { sha: ref },
		contents: {
			type: 'file',
			sha: gitBlobOid(bytes),
			encoding: 'base64',
			content: bytes.toString('base64'),
		},
	});
}

async function findingsFor(pin, bytes, fetchImpl) {
	const { findings } = await verifyUpstreamObject({ pin, bytes, fetchImpl });
	return findings.join('\n');
}

/* =========================================================================
 * The binding itself
 * ====================================================================== */

test('the pinned schema hashes to the git blob OID recorded beside it', () => {
	// The value that makes the upstream comparison possible at all: a blob OID is
	// a pure function of the bytes, so this number is directly comparable with
	// what GitHub reports for the path at the ref, with nothing local in between.
	assert.equal(gitBlobOid(BYTES), PIN.git_blob_sha1);
	assert.equal(sha256(BYTES), PIN.sha256);
	assert.equal(BYTES.length, PIN.bytes);
	assert.deepEqual(checkPinIntegrity(PIN, BYTES), []);
});

test('a ref that is not a 40-hex commit id is refused before any request', () => {
	for (const ref of ['staging', 'v1.6.0', 'E710FFB31A983B2AD993845DCA7D3263B81DE100', '']) {
		assert.equal(isCommitId(ref), false, `${ref} must not read as a commit id`);
	}
	assert.equal(isCommitId(PIN.ref), true);
});

test('the repository field cannot name a host other than github.com', () => {
	// This value selects who answers the provenance question. If it were free
	// text, the "upstream" check could be answered by whoever wrote the pin.
	for (const url of [
		'https://github.example.test/equaltoai/lesser',
		'http://github.com/equaltoai/lesser',
		'https://github.com.evil.test/equaltoai/lesser',
		'https://github.com/equaltoai',
		'https://github.com/equaltoai/lesser/../../other',
	]) {
		assert.equal(parseGitHubRepository(url), null, `${url} must not parse`);
	}
	assert.deepEqual(parseGitHubRepository(PIN.repository), {
		owner: 'equaltoai',
		repo: 'lesser',
	});
});

/* =========================================================================
 * Offline integrity — what it does catch
 * ====================================================================== */

test('a fabricated superset with a stale blob OID fails integrity', async () => {
	const fabricated = Buffer.concat([
		BYTES,
		Buffer.from('\nextend type Actor { fabricatedContractField: String }\n'),
	]);
	// The author updated sha256 and bytes but not the OID — the partial version
	// of the review's probe 2.
	const pin = { ...PIN, sha256: sha256(fabricated), bytes: fabricated.length };

	const findings = checkPinIntegrity(pin, fabricated).join('\n');
	assert.match(findings, /does not hash to its pinned git blob OID/);
});

test('a missing pin field is a finding, never a satisfied check', () => {
	for (const field of ['ref', 'sha256', 'bytes', 'git_blob_sha1', 'repository', 'upstream_path']) {
		const pin = { ...PIN };
		delete pin[field];
		const findings = checkPinIntegrity(pin, BYTES).join('\n');
		assert.match(findings, new RegExp(`missing \`${field}\``), `${field} must be required`);
	}
});

/* =========================================================================
 * Offline integrity — what it CANNOT catch, stated rather than implied
 * ====================================================================== */

test('a fully self-consistent fabricated superset passes integrity — and that is why the upstream check exists', async () => {
	const fabricated = Buffer.concat([
		BYTES,
		Buffer.from('\nextend type Actor { fabricatedContractField: String }\n'),
	]);
	const pin = {
		...PIN,
		sha256: sha256(fabricated),
		bytes: fabricated.length,
		git_blob_sha1: gitBlobOid(fabricated),
	};

	// Exactly the review's probe 2, carried all the way: every local value agrees.
	assert.deepEqual(checkPinIntegrity(pin, fabricated), []);

	// And upstream refuses it, because lesser's object is not these bytes.
	const findings = await findingsFor(pin, fabricated, honestGitHub());
	assert.match(findings, /the git object upstream does not match the pinned bytes/);
	assert.match(findings, /fabricated or edited/);
});

/* =========================================================================
 * Upstream dereference — every direction the review demonstrated
 * ====================================================================== */

test('a forty-f ref fails: the commit object does not resolve', async () => {
	const pin = { ...PIN, ref: 'f'.repeat(40) };
	// A fake ref is well-formed hex; only dereferencing it can tell.
	assert.equal(isCommitId(pin.ref), true);

	const findings = await findingsFor(pin, BYTES, githubReturning({ commit: null, contents: null }));
	assert.match(findings, /could not be dereferenced \(HTTP 404\)/);
	assert.match(findings, new RegExp(pin.ref));
});

test('a commit that resolves to a different sha fails', async () => {
	const findings = await findingsFor(
		PIN,
		BYTES,
		githubReturning({ commit: { sha: 'a'.repeat(40) }, contents: null })
	);
	assert.match(findings, /does not name the object GitHub resolved/);
});

test('a wrong upstream path fails: there is no object to compare', async () => {
	const pin = { ...PIN, upstream_path: 'docs/contracts/not-the-schema.graphql' };
	const findings = await findingsFor(
		pin,
		BYTES,
		githubReturning({ commit: { sha: pin.ref }, contents: null })
	);
	assert.match(findings, /not-the-schema\.graphql/);
	assert.match(findings, /could not be dereferenced/);
});

test('a wrong repository fails, and is never even requested from the wrong host', async () => {
	const pin = { ...PIN, repository: 'https://github.com/attacker/lesser' };
	const seen = [];
	const findings = await findingsFor(pin, BYTES, async (url) => {
		seen.push(url);
		return { ok: false, status: 404, json: async () => ({}) };
	});
	assert.match(findings, /could not be dereferenced/);
	assert.ok(
		seen.every((url) => url.startsWith('https://api.github.com/repos/attacker/lesser')),
		'the declared repository is the one dereferenced — no silent substitution'
	);
});

test('a stale schema fails: upstream has moved to a different object', async () => {
	// The pin still names an old ref; upstream at that path now hashes differently.
	const moved = Buffer.concat([BYTES, Buffer.from('\ntype AddedUpstreamLater { id: ID! }\n')]);
	const findings = await findingsFor(PIN, BYTES, honestGitHub(moved));
	assert.match(findings, /the git object upstream does not match the pinned bytes/);
	assert.match(findings, new RegExp(gitBlobOid(moved)));
});

test('an unreachable GitHub is an unverified pin, not a passing one', async () => {
	const findings = await findingsFor(PIN, BYTES, async () => {
		throw new Error('getaddrinfo ENOTFOUND api.github.com');
	});
	assert.match(findings, /could not reach GitHub/);
	assert.match(findings, /never a passing one/);
});

test('a body that is not a file, or not base64, fails rather than falling back', async () => {
	const asDirectory = await findingsFor(
		PIN,
		BYTES,
		githubReturning({ commit: { sha: PIN.ref }, contents: { type: 'dir', sha: 'x' } })
	);
	assert.match(asDirectory, /is not a file/);

	const unencoded = await findingsFor(
		PIN,
		BYTES,
		githubReturning({
			commit: { sha: PIN.ref },
			contents: { type: 'file', sha: PIN.git_blob_sha1, encoding: 'none', content: '' },
		})
	);
	assert.match(unencoded, /encoding none/);
});

test('a response whose content does not hash to the blob id it reports is refused', async () => {
	// GitHub agreeing with the pin's OID while returning other bytes would let the
	// name check pass over content nobody verified. Both are compared.
	const findings = await findingsFor(
		PIN,
		BYTES,
		githubReturning({
			commit: { sha: PIN.ref },
			contents: {
				type: 'file',
				sha: PIN.git_blob_sha1,
				encoding: 'base64',
				content: Buffer.from('not the schema').toString('base64'),
			},
		})
	);
	assert.match(findings, /does not hash to the blob id it reported/);
});

test('the honest upstream object passes, so the reds above are not vacuous', async () => {
	const { findings, observed } = await verifyUpstreamObject({
		pin: PIN,
		bytes: BYTES,
		fetchImpl: honestGitHub(),
	});
	assert.deepEqual(findings, []);
	assert.equal(observed.upstream_blob, PIN.git_blob_sha1);
	assert.equal(observed.sha256, PIN.sha256);
	assert.equal(observed.bytes, PIN.bytes);
});

test('a token, when present, is sent as a header and never appears in output', async () => {
	let authorization = null;
	// Bound to a name rather than called as `honestGitHub()(url)`. The
	// call-of-a-call is a shape CON-5's closure walk cannot follow, and the honest
	// repair is to stop writing code it cannot read rather than to disclose past
	// it: a disclosure is a count of what a reading missed, not a licence to keep
	// adding to the count.
	const upstream = honestGitHub();
	const { findings } = await verifyUpstreamObject({
		pin: PIN,
		bytes: BYTES,
		token: 'test-token-value',
		fetchImpl: async (url, init) => {
			authorization = init?.headers?.authorization ?? null;
			return upstream(url);
		},
	});
	assert.equal(authorization, 'Bearer test-token-value');
	assert.ok(
		!findings.join('\n').includes('test-token-value'),
		'a credential must never reach the report'
	);
});

/* =========================================================================
 * The mechanism has to actually run
 * ====================================================================== */

test('the upstream check is wired as a required CI job and a package script', () => {
	// A verifier nothing invokes is a file, not a gate. This is the "no silent
	// cap" half: the review's finding is only closed while the mechanism runs.
	const workflow = readFileSync(join(REPO, '.github/workflows/schema-provenance.yml'), 'utf8');
	assert.match(workflow, /pull_request/);
	assert.match(workflow, /branches:\s*\[staging\]/);
	assert.match(workflow, /node scripts\/verify-schema-provenance\.mjs/);

	const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;
	assert.equal(scripts['validate:schema-provenance'], 'node scripts/verify-schema-provenance.mjs');
});

test('the offline gate does not claim provenance in its own words', () => {
	// The review's finding was partly a CLAIM defect: a green offline run read as
	// "this is lesser's schema". The gate now says what it checked.
	const gate = readFileSync(join(REPO, 'scripts/audit-graphql-contract.mjs'), 'utf8');
	assert.match(gate, /INTEGRITY here, not provenance/);
	assert.match(gate, /verify-schema-provenance\.mjs/);
});
