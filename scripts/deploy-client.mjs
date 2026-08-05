#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALID_STAGES = new Set(['dev', 'staging', 'live']);
const REQUIRED_ARTIFACTS = [
	'build/server/handler.mjs',
	'build/server/client-manifest.json',
	'build/client/.vite/manifest.json',
	'facetheory.lesser.json',
];
const REQUIRED_STACK_OUTPUTS = [
	'ClientBucketName',
	'ClientArtifactBucketName',
	'ClientInstallManifestKey',
	'FrontendDistributionId',
];
const VALUE_OPTIONS = new Set(['--app', '--base-domain', '--stage', '--aws-profile', '--state']);
const BOOLEAN_OPTIONS = new Set(['--dry-run', '--skip-install', '--skip-check', '--skip-build']);

export function usage() {
	return [
		'Usage:',
		'  pnpm run deploy -- --app <slug> --base-domain <domain> --stage <dev|staging|live> --aws-profile <profile> [options]',
		'',
		'Required instance parameters:',
		'  --app <slug>          Lesser instance slug.',
		'  --base-domain <name>  Lesser instance base domain.',
		'  --stage <stage>       One of dev, staging, or live.',
		'  --aws-profile <name>  AWS profile for the deployed instance.',
		'',
		'Options:',
		'  --state <path>        Lesser deployment receipt. Defaults to',
		'                        ~/.lesser/<app>/<base-domain>/state.json.',
		'  --dry-run             Validate local inputs and print the resolved plan only.',
		'  --skip-install        Skip pnpm install --frozen-lockfile.',
		'  --skip-check          Skip pnpm run svelte-check.',
		'  --skip-build          Skip pnpm run build and use existing artifacts.',
		'  -h, --help            Show this help.',
		'',
		'Stage origin mapping:',
		'  dev      -> https://dev.<base-domain>',
		'  staging  -> https://staging.<base-domain>',
		'  live     -> https://<base-domain>',
	].join('\n');
}

function optionValue(argv, index, option) {
	const argument = argv[index];
	const equals = argument.indexOf('=');
	if (equals !== -1) {
		const value = argument.slice(equals + 1);
		if (!value) throw new Error(`Missing value for ${option}`);
		return { value, consumed: 1 };
	}

	const value = argv[index + 1];
	if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
	return { value, consumed: 2 };
}

export function parseCliArgs(argv) {
	const values = Object.create(null);
	const flags = new Set();
	let help = false;
	let separator = false;

	for (let index = 0; index < argv.length;) {
		const argument = argv[index];
		if (argument === '--') {
			if (separator) throw new Error('Duplicate option separator --');
			separator = true;
			index += 1;
			continue;
		}
		if (argument === '-h' || argument === '--help') {
			help = true;
			index += 1;
			continue;
		}

		const option = argument.split('=', 1)[0];
		if (VALUE_OPTIONS.has(option)) {
			if (Object.hasOwn(values, option)) throw new Error(`Duplicate option ${option}`);
			const { value, consumed } = optionValue(argv, index, option);
			values[option] = value;
			index += consumed;
			continue;
		}
		if (BOOLEAN_OPTIONS.has(argument)) {
			if (flags.has(argument)) throw new Error(`Duplicate option ${argument}`);
			flags.add(argument);
			index += 1;
			continue;
		}
		throw new Error(`Unknown option ${argument}`);
	}

	if (help) return { help: true };

	const missing = [...VALUE_OPTIONS]
		.filter((option) => option !== '--state')
		.filter((option) => !Object.hasOwn(values, option));
	if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);

	return {
		help: false,
		app: normalizeApp(values['--app']),
		baseDomain: normalizeBaseDomain(values['--base-domain']),
		stage: normalizeStage(values['--stage']),
		awsProfile: nonEmpty(values['--aws-profile'], '--aws-profile'),
		state: values['--state'] ?? null,
		dryRun: flags.has('--dry-run'),
		skipInstall: flags.has('--skip-install'),
		skipCheck: flags.has('--skip-check'),
		skipBuild: flags.has('--skip-build'),
	};
}

function nonEmpty(value, option) {
	const normalized = String(value ?? '').trim();
	if (!normalized) throw new Error(`${option} must not be empty`);
	return normalized;
}

export function normalizeApp(value) {
	const app = String(value ?? '')
		.trim()
		.toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app)) {
		throw new Error(`Invalid --app ${JSON.stringify(value)}; expected a lowercase slug`);
	}
	return app;
}

export function normalizeBaseDomain(value) {
	const domain = String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/\.$/, '');
	if (!domain) throw new Error('--base-domain must not be empty');
	if (domain.length > 253 || domain.includes('/') || domain.includes(':')) {
		throw new Error(`Invalid --base-domain ${JSON.stringify(value)}`);
	}
	const labels = domain.split('.');
	if (labels.length < 2) throw new Error(`--base-domain must be a fully-qualified domain name`);
	for (const label of labels) {
		if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
			throw new Error(`Invalid --base-domain ${JSON.stringify(value)}`);
		}
	}
	return domain;
}

export function normalizeStage(value) {
	const stage = String(value ?? '')
		.trim()
		.toLowerCase();
	if (!VALID_STAGES.has(stage)) {
		throw new Error(`Invalid --stage ${JSON.stringify(value)}; expected dev, staging, or live`);
	}
	return stage;
}

export function stageOrigin(stage, baseDomain) {
	return `https://${stage === 'live' ? baseDomain : `${stage}.${baseDomain}`}`;
}

export function resolveStatePath(options, { cwd = process.cwd(), home = os.homedir() } = {}) {
	if (options.state) return path.resolve(cwd, options.state);
	if (!home) throw new Error('Could not resolve the home directory for the default --state path');
	return path.join(home, '.lesser', options.app, options.baseDomain, 'state.json');
}

export function buildPlan(options, context = {}) {
	const statePath = resolveStatePath(options, context);
	const origin = stageOrigin(options.stage, options.baseDomain);
	const commands = [];
	if (!options.skipInstall) commands.push(['pnpm', 'install', '--frozen-lockfile']);
	if (!options.skipCheck) commands.push(['pnpm', 'run', 'svelte-check']);
	if (!options.skipBuild) commands.push(['pnpm', 'run', 'build']);
	commands.push([
		'lesser',
		'client',
		'install',
		'--app',
		options.app,
		'--base-domain',
		options.baseDomain,
		'--stage',
		options.stage,
		'--aws-profile',
		options.awsProfile,
		'--state',
		statePath,
		'--config',
		'facetheory.lesser.json',
		'--skip-build',
	]);
	commands.push([
		'curl',
		'--fail',
		'--silent',
		'--show-error',
		'--output',
		'/dev/null',
		`${origin}/l/`,
	]);

	return { ...options, statePath, origin, commands };
}

export function shellQuote(value) {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function commandLine(command) {
	return command.map(shellQuote).join(' ');
}

export function formatPlan(plan) {
	return [
		`deploy-client: ${plan.dryRun ? 'dry-run ' : ''}resolved plan`,
		`  app: ${plan.app}`,
		`  base-domain: ${plan.baseDomain}`,
		`  stage: ${plan.stage}`,
		`  aws-profile: ${plan.awsProfile}`,
		`  state: ${plan.statePath}`,
		`  install target: ${plan.origin}/l/`,
		`  verify target: ${plan.origin}/l/`,
		'  commands:',
		...plan.commands.map((command) => `    $ ${commandLine(command)}`),
	].join('\n');
}

async function executablePath(name, envPath = process.env.PATH ?? '') {
	for (const directory of envPath.split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, name);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return null;
}

async function assertReadableFile(file, label) {
	try {
		const info = await stat(file);
		if (!info.isFile()) throw new Error('not a regular file');
		await access(file, constants.R_OK);
	} catch (error) {
		throw new Error(`${label} is missing or unreadable at ${file}: ${error.message}`);
	}
}

export async function assertBuildArtifacts(repoRoot = REPO_ROOT) {
	for (const artifact of REQUIRED_ARTIFACTS) {
		await assertReadableFile(path.join(repoRoot, artifact), `Required build artifact ${artifact}`);
	}
}

export function validateReceipt(receipt, plan, statePath) {
	if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
		throw new Error(`Deployment receipt ${statePath} must contain a JSON object`);
	}
	if (receipt.app !== plan.app || receipt.base_domain !== plan.baseDomain) {
		throw new Error(
			`Deployment receipt ${statePath} targets ${receipt.app ?? '<missing>'}/${receipt.base_domain ?? '<missing>'}, expected ${plan.app}/${plan.baseDomain}`
		);
	}
	const selectedStage = receipt.stages?.[plan.stage];
	if (!selectedStage)
		throw new Error(`Deployment receipt ${statePath} is missing stage ${plan.stage}`);
	const outputs = selectedStage.stack_outputs ?? {};
	const missingOutputs = REQUIRED_STACK_OUTPUTS.filter(
		(name) => !String(outputs[name] ?? '').trim()
	);
	if (missingOutputs.length) {
		throw new Error(
			`Deployment receipt ${statePath} stage ${plan.stage} is missing stack outputs: ${missingOutputs.join(', ')}`
		);
	}
}

export async function preflight(
	plan,
	{ repoRoot = REPO_ROOT, envPath = process.env.PATH ?? '' } = {}
) {
	const requiredExecutables = new Set(['lesser', 'curl']);
	if (plan.commands.some(([command]) => command === 'pnpm')) requiredExecutables.add('pnpm');
	for (const executable of requiredExecutables) {
		if (!(await executablePath(executable, envPath))) {
			throw new Error(
				`${executable} binary is missing from PATH${executable === 'lesser' ? '; install the current lesser CLI before deploying' : ''}`
			);
		}
	}

	await assertReadableFile(plan.statePath, 'Deployment receipt');
	let receipt;
	try {
		receipt = JSON.parse(await readFile(plan.statePath, 'utf8'));
	} catch (error) {
		throw new Error(`Deployment receipt ${plan.statePath} is not valid JSON: ${error.message}`);
	}
	validateReceipt(receipt, plan, plan.statePath);

	await assertReadableFile(
		path.join(repoRoot, 'facetheory.lesser.json'),
		'Required build artifact facetheory.lesser.json'
	);
	if (plan.dryRun || plan.skipBuild) await assertBuildArtifacts(repoRoot);
}

function run(command, args, { cwd = REPO_ROOT } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], { cwd: cwd, stdio: 'inherit' });
		child.on('error', (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
		child.on('close', (code, signal) => {
			if (code === 0) resolve();
			else if (signal) reject(new Error(`${command} terminated by signal ${signal}`));
			else reject(new Error(`${command} exited with code ${code}`));
		});
	});
}

export async function executePlan(plan, { repoRoot = REPO_ROOT, runCommand = run } = {}) {
	console.log(formatPlan(plan));
	if (plan.dryRun) {
		console.log('deploy-client: dry-run complete; no commands executed');
		return;
	}

	for (const [command, ...args] of plan.commands) {
		if (command === 'lesser') await assertBuildArtifacts(repoRoot);
		console.log(`\n$ ${commandLine([command, ...args])}`);
		await runCommand(command, args, { cwd: repoRoot });
	}
	console.log('\ndeploy-client: install and verification complete');
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseCliArgs(argv);
	if (options.help) {
		console.log(usage());
		return;
	}
	const plan = buildPlan(options);
	await preflight(plan);
	await executePlan(plan);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(`deploy-client: ${error.message}`);
		process.exitCode = 1;
	});
}
