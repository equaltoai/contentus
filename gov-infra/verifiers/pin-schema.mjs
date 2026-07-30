#!/usr/bin/env node
/**
 * Schema for contentus-disclosed-upstream-findings.json, shared by SEC-2 and SEC-7.
 *
 * Both gates read this file with optional chaining and `?? []`. That is the right
 * defensive shape for a missing section and the wrong one for a misspelled key: a
 * `must_pas` typo silently turns the integrity assertions into a loop over an empty
 * array, and the control still reports PASS. A pin that has quietly stopped
 * asserting anything is worse than no pin, because it still looks like one in the
 * report.
 *
 * So the file is validated before either gate reads it: required keys present and
 * well-typed, severities from a closed set, and no unrecognized key anywhere. An
 * unrecognized key is an error rather than a warning — it is exactly what a typo
 * looks like, and guessing which of the two it is has no safe answer.
 */
import { readFileSync } from 'node:fs';

export const PIN = 'gov-infra/planning/contentus-disclosed-upstream-findings.json';

const SEVERITIES = new Set(['error', 'warning', 'info', 'low', 'moderate', 'high', 'critical']);

function checkKeys(value, path, { required, optional }, findings) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		findings.push(`${path} must be an object`);
		return false;
	}
	const known = new Set([...required, ...optional]);
	for (const key of required)
		if (!Object.hasOwn(value, key)) findings.push(`${path}.${key} is required and is missing`);
	for (const key of Object.keys(value))
		if (!known.has(key))
			findings.push(
				`${path}.${key} is not a recognized key — a typo here silently disables an assertion`
			);
	return true;
}

function checkStringArray(value, path, findings, { allowEmpty = false } = {}) {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry)) {
		findings.push(`${path} must be an array of non-empty strings`);
		return;
	}
	if (!allowEmpty && value.length === 0) findings.push(`${path} must not be empty`);
}

function checkSeverity(value, path, findings) {
	if (typeof value !== 'string' || !SEVERITIES.has(value))
		findings.push(
			`${path} must be one of ${[...SEVERITIES].join(', ')} (got ${JSON.stringify(value)})`
		);
}

export function validatePin(pin) {
	const findings = [];
	checkKeys(
		pin,
		'pin',
		{ required: ['npm_audit', 'greater_doctor'], optional: ['$comment'] },
		findings
	);

	const audit = pin.npm_audit;
	if (
		checkKeys(
			audit,
			'npm_audit',
			{ required: ['gate', 'rubric_item', 'advisories'], optional: ['$comment'] },
			findings
		)
	) {
		if (!Array.isArray(audit.advisories)) findings.push('npm_audit.advisories must be an array');
		else
			audit.advisories.forEach((advisory, index) => {
				const path = `npm_audit.advisories[${index}]`;
				if (
					!checkKeys(
						advisory,
						path,
						{
							required: [
								'id',
								'severity',
								'module',
								'vulnerable_versions',
								'paths',
								'owner',
								'upstream_issue',
								'why_not_fixable_here',
								'routing_status',
								'sunset',
							],
							optional: ['$comment'],
						},
						findings
					)
				)
					return;
				for (const key of ['id', 'module', 'vulnerable_versions', 'owner', 'upstream_issue'])
					if (typeof advisory[key] !== 'string' || !advisory[key])
						findings.push(`${path}.${key} must be a non-empty string`);
				checkSeverity(advisory.severity, `${path}.severity`, findings);
				checkStringArray(advisory.paths, `${path}.paths`, findings);
				for (const key of ['why_not_fixable_here', 'routing_status', 'sunset'])
					checkStringArray(advisory[key], `${path}.${key}`, findings);
			});
	}

	const doctor = pin.greater_doctor;
	if (
		checkKeys(
			doctor,
			'greater_doctor',
			{
				required: [
					'gate',
					'rubric_item',
					'cli_pin',
					'must_pass',
					'must_pass_reason',
					'disclosed_failures',
					'disclosed_warnings',
				],
				optional: ['$comment'],
			},
			findings
		)
	) {
		if (typeof doctor.cli_pin !== 'string' || !/^greater-v\d+\.\d+\.\d+/.test(doctor.cli_pin))
			findings.push('greater_doctor.cli_pin must be a `greater-v<semver>` release tag');
		checkStringArray(doctor.must_pass, 'greater_doctor.must_pass', findings);
		checkStringArray(doctor.must_pass_reason, 'greater_doctor.must_pass_reason', findings);

		if (!Array.isArray(doctor.disclosed_failures))
			findings.push('greater_doctor.disclosed_failures must be an array');
		else
			doctor.disclosed_failures.forEach((entry, index) => {
				const path = `greater_doctor.disclosed_failures[${index}]`;
				if (
					!checkKeys(
						entry,
						path,
						{
							required: ['name', 'severity', 'upstream_issue', 'owner', 'summary', 'sunset'],
							optional: ['missing_dependencies', '$comment'],
						},
						findings
					)
				)
					return;
				for (const key of ['name', 'upstream_issue', 'owner'])
					if (typeof entry[key] !== 'string' || !entry[key])
						findings.push(`${path}.${key} must be a non-empty string`);
				checkSeverity(entry.severity, `${path}.severity`, findings);
				checkStringArray(entry.summary, `${path}.summary`, findings);
				checkStringArray(entry.sunset, `${path}.sunset`, findings);
				if (Object.hasOwn(entry, 'missing_dependencies'))
					checkStringArray(entry.missing_dependencies, `${path}.missing_dependencies`, findings);
			});

		if (!Array.isArray(doctor.disclosed_warnings))
			findings.push('greater_doctor.disclosed_warnings must be an array');
		else
			doctor.disclosed_warnings.forEach((entry, index) => {
				const path = `greater_doctor.disclosed_warnings[${index}]`;
				if (
					!checkKeys(
						entry,
						path,
						{ required: ['names', 'severity', 'summary'], optional: ['$comment'] },
						findings
					)
				)
					return;
				checkStringArray(entry.names, `${path}.names`, findings);
				checkSeverity(entry.severity, `${path}.severity`, findings);
				checkStringArray(entry.summary, `${path}.summary`, findings);
			});
	}

	return findings;
}

/** Read and validate the pin, or exit 1. A pin that cannot be trusted is not a pin. */
export function loadPin() {
	let pin;
	try {
		pin = JSON.parse(readFileSync(PIN, 'utf8'));
	} catch (error) {
		console.error(`${PIN} is missing or unparseable: ${error.message}`);
		process.exit(1);
	}
	const findings = validatePin(pin);
	if (findings.length) {
		console.error(`${PIN} does not match the pin schema:`);
		for (const finding of findings) console.error(`  ${finding}`);
		console.error('');
		console.error('A malformed pin does not assert what it appears to assert. Repair the file;');
		console.error('never route around it by loosening the gate that reads it.');
		process.exit(1);
	}
	return pin;
}
