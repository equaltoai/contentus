import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateRequiredWorkflows } from '../gov-infra/verifiers/validate-workflows.mjs';

const AUTH = '        run: node gov-infra/verifiers/authenticate-release-index.mjs';
const RUBRIC = '        run: bash gov-infra/verifiers/gov-verify-rubric.sh';

function withWorkflows(mutate, check) {
	const root = mkdtempSync(join(tmpdir(), 'contentus-workflows-'));
	const directory = join(root, 'workflows');
	cpSync('.github/workflows', directory, { recursive: true });
	const file = join(directory, 'gov-rubric.yml');
	writeFileSync(file, mutate(readFileSync(file, 'utf8')));
	try {
		check(validateRequiredWorkflows(directory));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('canonical release authentication is unique and precedes the rubric consumer', () => {
	withWorkflows(
		(source) => source,
		(findings) => assert.deepEqual(findings, [])
	);
});

test('moved-after and duplicate release authentication fail workflow validation', () => {
	withWorkflows(
		(source) =>
			source
				.replace(AUTH, '        run: __AUTH_PLACEHOLDER__')
				.replace(RUBRIC, AUTH)
				.replace('        run: __AUTH_PLACEHOLDER__', RUBRIC),
		(findings) => assert.ok(findings.some((finding) => finding.includes('must complete before')))
	);
	withWorkflows(
		(source) => source.replace(AUTH, `${AUTH}\n      - name: Duplicate authentication\n${AUTH}`),
		(findings) => assert.ok(findings.some((finding) => finding.includes('exactly once')))
	);
});

test('conditional and continue-on-error release authentication cannot establish evidence', () => {
	for (const property of ['        if: false', '        continue-on-error: true']) {
		withWorkflows(
			(source) => source.replace(AUTH, `${property}\n${AUTH}`),
			(findings) =>
				assert.ok(
					findings.some(
						(finding) => finding.includes('sentinel missing') || finding.includes('exactly once')
					),
					findings.join('\n')
				)
		);
	}
});
