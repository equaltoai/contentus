import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	assertBuildArtifacts,
	buildPlan,
	executePlan,
	formatPlan,
	normalizeBaseDomain,
	parseCliArgs,
	preflight,
	stageOrigin,
	validateReceipt,
} from './deploy-client.mjs';

const required = [
	'--app',
	'new-instance',
	'--base-domain',
	'Example.TEST.',
	'--stage',
	'dev',
	'--aws-profile',
	'OperatorProfile',
];

function receipt(plan, overrides = {}) {
	return {
		app: plan.app,
		base_domain: plan.baseDomain,
		stages: {
			[plan.stage]: {
				stack_outputs: {
					ClientBucketName: 'client-bucket',
					ClientArtifactBucketName: 'artifact-bucket',
					ClientInstallManifestKey: 'install/current.json',
					FrontendDistributionId: 'distribution-id',
				},
			},
		},
		...overrides,
	};
}

test('requires exactly the four instance parameters and accepts operational flags', () => {
	const options = parseCliArgs([
		'--',
		...required,
		'--state=./receipt.json',
		'--dry-run',
		'--skip-install',
		'--skip-check',
		'--skip-build',
	]);
	assert.deepEqual(options, {
		help: false,
		app: 'new-instance',
		baseDomain: 'example.test',
		stage: 'dev',
		awsProfile: 'OperatorProfile',
		state: './receipt.json',
		dryRun: true,
		skipInstall: true,
		skipCheck: true,
		skipBuild: true,
	});
	assert.throws(
		() => parseCliArgs(required.slice(0, -2)),
		/Missing required options: --aws-profile/
	);
	assert.throws(
		() => parseCliArgs([...required, '--target', 'registered-name']),
		/Unknown option --target/
	);
});

test('normalizes the domain and derives stage origins like lesser', () => {
	assert.equal(normalizeBaseDomain('Example.TEST.'), 'example.test');
	assert.equal(stageOrigin('dev', 'example.test'), 'https://dev.example.test');
	assert.equal(stageOrigin('staging', 'example.test'), 'https://staging.example.test');
	assert.equal(stageOrigin('live', 'example.test'), 'https://example.test');
	assert.throws(() => normalizeBaseDomain('https://example.test'), /Invalid --base-domain/);
});

test('builds the frozen install, check, build, lesser install, and verify plan', () => {
	const options = parseCliArgs([...required, '--state', './receipt.json', '--dry-run']);
	const plan = buildPlan(options, { cwd: '/operator/repo', home: '/operator' });
	assert.deepEqual(plan.commands.slice(0, 3), [
		['pnpm', 'install', '--frozen-lockfile'],
		['pnpm', 'run', 'svelte-check'],
		['pnpm', 'run', 'build'],
	]);
	assert.deepEqual(plan.commands[3], [
		'lesser',
		'client',
		'install',
		'--app',
		'new-instance',
		'--base-domain',
		'example.test',
		'--stage',
		'dev',
		'--aws-profile',
		'OperatorProfile',
		'--state',
		'/operator/repo/receipt.json',
		'--config',
		'facetheory.lesser.json',
		'--skip-build',
	]);
	assert.deepEqual(plan.commands[4], [
		'curl',
		'--fail',
		'--silent',
		'--show-error',
		'--output',
		'/dev/null',
		'https://dev.example.test/l/',
	]);
	assert.match(formatPlan(plan), /install target: https:\/\/dev\.example\.test\/l\//);
});

test('skip flags remove only local preparation commands', () => {
	const plan = buildPlan(
		parseCliArgs([...required, '--dry-run', '--skip-install', '--skip-check', '--skip-build']),
		{ home: '/operator' }
	);
	assert.deepEqual(
		plan.commands.map(([command]) => command),
		['lesser', 'curl']
	);
});

test('validates that the receipt targets the requested instance and carries stage outputs', () => {
	const plan = buildPlan(parseCliArgs([...required, '--dry-run']), { home: '/operator' });
	assert.doesNotThrow(() => validateReceipt(receipt(plan), plan, plan.statePath));
	assert.throws(
		() => validateReceipt(receipt(plan, { app: 'another-instance' }), plan, plan.statePath),
		/targets another-instance\/example\.test/
	);
	const incomplete = receipt(plan);
	delete incomplete.stages.dev.stack_outputs.FrontendDistributionId;
	assert.throws(() => validateReceipt(incomplete, plan, plan.statePath), /FrontendDistributionId/);
	assert.throws(
		() => validateReceipt({ ...receipt(plan), stages: {} }, plan, plan.statePath),
		/is missing stage dev/
	);
});

test('dry-run prints the resolved plan without executing any command', async () => {
	const plan = buildPlan(parseCliArgs([...required, '--dry-run']), { home: '/operator' });
	let calls = 0;
	const lines = [];
	const originalLog = console.log;
	console.log = (line) => lines.push(line);
	try {
		await executePlan(plan, {
			runCommand: async () => {
				calls += 1;
			},
		});
	} finally {
		console.log = originalLog;
	}
	assert.equal(calls, 0);
	assert.match(lines.join('\n'), /dry-run complete; no commands executed/);
});

test('dry-run supports a fresh clone unless build reuse is requested', async (context) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'contentus-deploy-fresh-'));
	const stubBin = await mkdtemp(path.join(os.tmpdir(), 'contentus-deploy-bin-'));
	context.after(() => rm(repoRoot, { recursive: true, force: true }));
	context.after(() => rm(stubBin, { recursive: true, force: true }));
	for (const executable of ['lesser', 'curl', 'pnpm']) {
		const stub = path.join(stubBin, executable);
		await writeFile(stub, '#!/bin/sh\nexit 0\n');
		await chmod(stub, 0o755);
	}

	await writeFile(path.join(repoRoot, 'facetheory.lesser.json'), '{}\n');
	const plan = buildPlan(parseCliArgs([...required, '--state', './receipt.json', '--dry-run']), {
		cwd: repoRoot,
	});
	await writeFile(plan.statePath, `${JSON.stringify(receipt(plan))}\n`);
	await assert.doesNotReject(() => preflight(plan, { repoRoot, envPath: stubBin }));

	const reusePlan = buildPlan(
		parseCliArgs([...required, '--state', './receipt.json', '--dry-run', '--skip-build']),
		{ cwd: repoRoot }
	);
	await assert.rejects(
		() => preflight(reusePlan, { repoRoot, envPath: stubBin }),
		/Required build artifact build\/server\/handler\.mjs is missing or unreadable/
	);
});

test('preflight fails clearly when lesser, state, or artifacts are absent', async (context) => {
	const plan = buildPlan(parseCliArgs([...required, '--dry-run']), { home: '/operator' });
	await assert.rejects(
		() => preflight(plan, { envPath: '' }),
		/lesser binary is missing from PATH/
	);

	const stubBin = await mkdtemp(path.join(os.tmpdir(), 'contentus-deploy-bin-'));
	context.after(() => rm(stubBin, { recursive: true, force: true }));
	for (const executable of ['lesser', 'curl', 'pnpm']) {
		const stub = path.join(stubBin, executable);
		await writeFile(stub, '#!/bin/sh\nexit 0\n');
		await chmod(stub, 0o755);
	}
	await assert.rejects(
		() => preflight(plan, { envPath: stubBin }),
		/Deployment receipt is missing or unreadable/
	);

	const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'contentus-deploy-test-'));
	context.after(() => rm(emptyRoot, { recursive: true, force: true }));
	await assert.rejects(
		() => assertBuildArtifacts(emptyRoot),
		/Required build artifact build\/server\/handler\.mjs is missing or unreadable/
	);
});
