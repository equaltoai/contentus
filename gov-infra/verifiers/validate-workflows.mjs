#!/usr/bin/env node
/**
 * Dependency-free, fail-closed structural validation for the narrow GitHub
 * Actions YAML vocabulary this repository accepts.  A full YAML parser is not
 * available in the locked offline dependency graph, so this scanner deliberately
 * rejects malformed lexical state instead of guessing past it.
 *
 * The run scanner models invocation presence through YAML literal/folded block
 * boundaries plus a deliberately small shell subset (comments, ordinary quotes,
 * continuations, queued heredocs, and a whole-logical-script evidence rule). The three
 * executable sentinels count only when every logical line decomposes solely through
 * `;`, `&&`, `|`, or newlines and one segment is exactly the command (with allowed
 * assignments/time/env prefixes and output redirections). Shell substitutions, reserved
 * words, `||`, grouping, and unmodelled syntax reject the whole script. A YAML
 * double-quoted run scalar containing a backslash is opaque: safely unescaping it is
 * outside this scanner. DCO remains presence-only evidence; CodeQL's `uses:` ref is
 * presence-only evidence too. Main-guard is executable evidence. Reusable-workflow job-level
 * `uses:` remains a structural finding. The known unloadable-but-uncertified shapes are
 * undefined aliases, failed merge keys, duplicate job/root keys, and non-mapping step
 * entries; branch protection contains them because an unloadable workflow reports no
 * check. This is not a general Bash or YAML interpreter.
 *
 * Three properties beyond the pin check, each closing a place where "the workflow file
 * looks fine" was standing in for "the workflow is constrained":
 *
 *   - Local actions are followed. `uses: ./path` was exempt from pinning, which is
 *     correct for the reference itself and wrong for what it reaches: a composite
 *     action in-tree can carry `uses: attacker/action@main` and inherit the exemption.
 *     Every `./` reference now has to resolve to an action manifest, and that manifest
 *     is scanned under the same rules, recursively.
 *   - Permissions are least-privilege by assertion. A workflow with no `permissions:`
 *     block inherits whatever the repository default is — a repository setting, not a
 *     repository invariant. Every workflow must declare one, and every scope in it must
 *     be read or none except the write grants pinned in the contract.
 *   - `run:` blocks may not interpolate `${{ github.event.* }}`. Event payload fields are
 *     attacker-authored text spliced into a shell script before the shell ever sees it;
 *     quoting cannot fix it. Passing through `env:` is the accepted pattern and the one
 *     this repository's workflows already use. This applies to every local composite
 *     action manifest the recursive scan reaches, not only to the workflow files: a
 *     composite action's `run:` is a workflow's `run:` one indirection later.
 *   - The `env:` indirection that rule recommends is only safe where the value is
 *     consumed as data. `env: PAYLOAD: ${{ github.event.* }}` plus `run: bash -c
 *     "$PAYLOAD"` contains no `${{ }}` in its `run:` and executes a pull-request title
 *     anyway. So an event-derived env value may not reach an executable sink, in
 *     workflows or in reached composites, and a composite may not carry an event
 *     expression in `env:` at all.
 *   - Every package-manager install in CI is exactly one of the pinned invocations. The
 *     boundary SEC-3 rests on is that no install anywhere runs dependency lifecycle
 *     scripts. The rubric could only ever fix its own install; the three installs in the
 *     workflows run *before* the rubric starts, so dropping `--ignore-scripts` from one
 *     of them executes dependency code and the rubric then reports green on the tree
 *     that code produced. An unasserted boundary is not a boundary.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readStrictJson } from './strict-json.mjs';

const workflowDirectory = '.github/workflows';
const requiredWorkflows = {
	'gov-rubric.yml': [
		'bash gov-infra/verifiers/gov-verify-rubric.sh',
		// The step that fetches and digest-verifies the greater release asset. SEC-7
		// extracts and executes its own copy of that asset, so without this step there
		// is no archive to extract and the control reports BLOCKED; MAI-4 binds the
		// step so it cannot be quietly dropped to convert a hard gate into a soft one.
		'node gov-infra/verifiers/install-greater-cli.mjs',
	],
	'dco.yml': ['Signed-off-by'],
	'lint.yml': ['pnpm run lint'],
	'test.yml': ['pnpm test'],
	'codeql.yml': ['github/codeql-action/init@'],
	// Promotion-only main enforcement must retain both its source-branch and
	// same-repository checks; workflow presence alone cannot establish that.
	'main-guard.yml': [
		'test "${BASE_REF}" = main',
		'test "${HEAD_REF}" = staging',
		'test "${HEAD_REPOSITORY}" = "${CURRENT_REPOSITORY}"',
	],
};
// Production callers use the fixed directory above. The optional argv directory
// is test-only so probes never write into the repository's real workflows.

function yamlFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true })
		.map((name) => join(directory, name))
		.filter((file) => /\.ya?ml$/i.test(file) && statSync(file).isFile());
}

function quotedEnd(source, start) {
	const quote = source[start];
	for (let cursor = start + 1; cursor < source.length; cursor += 1) {
		if (source[cursor] !== quote) continue;
		if (quote === "'" && source[cursor + 1] === "'") {
			cursor += 1;
			continue;
		}
		if (quote === '"' && escapedByOddBackslashes(source, cursor)) continue;
		return cursor + 1;
	}
	throw new Error('unterminated quoted scalar');
}

// In double-quoted YAML scalars a quote is escaped only when it follows an odd
// run of backslashes. Looking at just the preceding byte makes `\\\\"` look
// escaped even though its final quote closes the scalar.
function escapedByOddBackslashes(source, cursor) {
	let run = 0;
	for (let index = cursor - 1; index >= 0 && source[index] === '\\'; index -= 1) run += 1;
	return run % 2 === 1;
}

function blockScalarHeader(value) {
	const match = value.match(/^([|>])([+-]?[1-9]?|[1-9]?[+-]?)(?:\s*(?:#.*)?)$/);
	if (!match) {
		if (/^[|>]/.test(value)) throw new Error('invalid block scalar header');
		return null;
	}
	const indicator = match[2].match(/\d/);
	return { explicitIndent: indicator ? Number(indicator[0]) : null };
}

function rejectNonPlainUsesValue(value) {
	if (blockScalarHeader(value.trimStart()))
		throw new Error('uses value must be a single-line scalar; block scalars are unsupported');
	const trimmed = value.trimStart();
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
		try {
			quotedEnd(trimmed, 0);
		} catch (error) {
			if (error.message === 'unterminated quoted scalar')
				throw new Error(
					'uses value must be a single-line scalar; multi-line quoted values are unsupported'
				);
			throw error;
		}
	}
}

function withoutComment(value) {
	const trimmed = value.trimStart();
	// Quotes only begin a quoted scalar at its first non-space character. An
	// apostrophe/double quote inside a plain scalar (for example "Don't ship")
	// must not poison the lexer for later flow mappings.
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
		const end = quotedEnd(trimmed, 0);
		const rest = trimmed.slice(end).trimStart();
		if (rest && !rest.startsWith('#')) throw new Error('unexpected text after quoted scalar');
		return trimmed.slice(0, end);
	}
	const comment = trimmed.search(/\s#/);
	return comment < 0 ? trimmed : trimmed.slice(0, comment);
}

function scalar(value) {
	const trimmed = withoutComment(value).trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	)
		return trimmed.slice(1, -1);
	return trimmed;
}

function readFlowToken(source, index, stops) {
	let cursor = index;
	while (/\s/.test(source[cursor] ?? '')) cursor += 1;
	const start = cursor;
	if (source[cursor] === '"' || source[cursor] === "'") {
		const end = quotedEnd(source, cursor);
		return { value: source.slice(cursor + 1, end - 1), next: end };
	}
	while (cursor < source.length && !stops.includes(source[cursor])) cursor += 1;
	return { value: source.slice(start, cursor).trim(), next: cursor };
}

function flowUses(source, start, findings) {
	let cursor = start + 1;
	while (cursor < source.length) {
		while (/\s/.test(source[cursor] ?? '')) cursor += 1;
		if (source[cursor] === '}') return cursor + 1;
		if (source[cursor] === '?') throw new Error('explicit YAML mapping keys are unsupported');
		const key = readFlowToken(source, cursor, ':}');
		cursor = key.next;
		while (/\s/.test(source[cursor] ?? '')) cursor += 1;
		if (source[cursor] !== ':') throw new Error('malformed flow mapping');
		cursor += 1;
		while (/\s/.test(source[cursor] ?? '')) cursor += 1;
		let value = '';
		if (source[cursor] === '{') cursor = flowUses(source, cursor, findings);
		else if (source[cursor] === '[') {
			// A flow sequence cannot contain a safe `uses` mapping without another
			// mapping brace; recurse into those braces and reject unmatched brackets.
			let depth = 1;
			cursor += 1;
			while (cursor < source.length && depth) {
				if (source[cursor] === '"' || source[cursor] === "'") cursor = quotedEnd(source, cursor);
				else if (source[cursor] === '{') cursor = flowUses(source, cursor, findings);
				else {
					if (source[cursor] === '[') depth += 1;
					if (source[cursor] === ']') depth -= 1;
					cursor += 1;
				}
			}
			if (depth) throw new Error('unterminated flow sequence');
		} else {
			const token = readFlowToken(source, cursor, ',}');
			value = token.value;
			cursor = token.next;
		}
		if (key.value === 'uses') findings.push(value);
		while (/\s/.test(source[cursor] ?? '')) cursor += 1;
		if (source[cursor] === ',') cursor += 1;
		else if (source[cursor] === '}') return cursor + 1;
		else throw new Error('unterminated flow mapping');
	}
	throw new Error('unterminated flow mapping');
}

function looksLikeFlowMapping(source, start) {
	let cursor = start + 1;
	while (/\s/.test(source[cursor] ?? '')) cursor += 1;
	// Explicit flow-map keys are valid YAML, but outside this deliberately
	// narrow scanner. Route them through flowUses so it fails closed instead of
	// letting a possible `uses` key evade the pre-gate.
	if (source[cursor] === '?') return true;
	if (source[cursor] === '"' || source[cursor] === "'") cursor = quotedEnd(source, cursor);
	else while (cursor < source.length && !/[:},\s]/.test(source[cursor])) cursor += 1;
	// YAML permits whitespace between a flow-map key and its colon. Do not use
	// this pre-gate to skip a mapping that flowUses must validate fail-closed.
	while (/\s/.test(source[cursor] ?? '')) cursor += 1;
	return source[cursor] === ':';
}

export function findUses(content) {
	const uses = [];
	const lines = content.split(/\r\n|\r|\n/);
	let quote = null;
	let block = null;

	// This is intentionally one forward lexical pass, not a YAML parser. It
	// recognizes only the scalar states which decide whether a `{` can introduce
	// a flow map. Anything it cannot delimit is rejected rather than guessed.
	for (const line of lines) {
		const indent = line.match(/^\s*/)[0].length;
		const nonBlank = /\S/.test(line);
		if (block && nonBlank) {
			if (block.contentIndent === null && indent > block.headerIndent) {
				block.contentIndent = block.explicitIndent ?? indent;
				if (indent < block.contentIndent) throw new Error('invalid block scalar indentation');
			}
			if (block.contentIndent !== null && indent >= block.contentIndent) continue;
			block = null; // empty blocks and dedented keys are both valid YAML.
		} else if (block) {
			continue;
		}

		const startsPlain = quote === null;
		const usesMatch = line.match(/^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:\s*(.*)$/);
		// A physical continuation of a quoted scalar is data, not a new mapping.
		// Real uses keys remain fail-closed only when the line began in plain state.
		if (usesMatch && startsPlain) rejectNonPlainUsesValue(usesMatch[1]);

		// A quote can span physical lines in YAML. It only starts at a mapping
		// value boundary; apostrophes in plain scalars (Don't) remain plain text.
		let cursor = 0;
		let comment = false;
		let valueBoundary = true;
		let blockHeader = null;
		while (cursor < line.length) {
			const char = line[cursor];
			if (quote) {
				if (quote === "'" && char === "'" && line[cursor + 1] === "'") {
					cursor += 2;
					continue;
				}
				if (char === quote && !(quote === '"' && escapedByOddBackslashes(line, cursor)))
					quote = null;
				cursor += 1;
				continue;
			}
			if (comment) break;
			if (char === '#' && (cursor === 0 || /\s/.test(line[cursor - 1]))) {
				comment = true;
				continue;
			}
			if ((char === "'" || char === '"') && valueBoundary) {
				quote = char;
				cursor += 1;
				continue;
			}
			if (char === ':') {
				let next = cursor + 1;
				while (/\s/.test(line[next] ?? '')) next += 1;
				valueBoundary = true;
				const blockHeaderValue = blockScalarHeader(line.slice(next));
				if (blockHeaderValue) {
					blockHeader = {
						headerIndent: indent,
						explicitIndent:
							blockHeaderValue.explicitIndent === null
								? null
								: indent + blockHeaderValue.explicitIndent,
						contentIndent: null,
					};
					break;
				}
				cursor += 1;
				continue;
			}
			if (char === '{' && looksLikeFlowMapping(line, cursor)) {
				cursor = flowUses(line, cursor, uses);
				valueBoundary = false;
				continue;
			}
			// YAML node properties between `:` and a scalar preserve the value boundary.
			if ((char === '&' || char === '*' || char === '!') && valueBoundary) {
				cursor += 1;
				while (/[^\s]/.test(line[cursor] ?? '')) cursor += 1;
				continue;
			}
			if (!/\s/.test(char)) valueBoundary = false;
			cursor += 1;
		}
		if (quote) continue;
		if (blockHeader) {
			block = blockHeader;
			continue;
		}
		// Block-form `uses` keys are only recognized when the physical line began
		// in plain lexical state; a closing quote later on this line cannot reopen it.
		if (usesMatch && startsPlain) uses.push(scalar(usesMatch[1]));
		if (/^\s*(?:-\s*)?\?(?:\s|$)/.test(line))
			throw new Error('explicit YAML mapping keys are unsupported');
	}
	if (quote) throw new Error('unterminated quoted scalar');
	return uses;
}

// A `./` reference names a directory holding an action manifest, or the manifest
// itself. Anything that does not resolve is a finding: an unresolvable local
// action is not a safe local action, it is an unscanned one.
function resolveLocalAction(reference, root) {
	const relativePath = reference.replace(/^\.\/?/, '');
	for (const name of ['action.yml', 'action.yaml']) {
		const candidate = join(root, relativePath, name);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	const direct = join(root, relativePath);
	if (/\.ya?ml$/i.test(direct) && existsSync(direct) && statSync(direct).isFile()) return direct;
	return null;
}

// Composite actions nest. A local action inherits no exemption for what it in turn
// uses, so each manifest is scanned under exactly these rules; `seen` keeps a cycle
// from recursing forever without letting it skip a first visit.
function collectUsesFindings(values, file, root, seen, findings) {
	for (const value of values) {
		if (!value.startsWith('./')) {
			if (!/^[^\s@]+@[0-9a-f]{40}$/i.test(value))
				findings.push(`${file}: non-immutable uses reference ${value}`);
			continue;
		}
		const manifest = resolveLocalAction(value, root);
		if (!manifest) {
			findings.push(
				`${file}: local action ${value} resolves to no action.yml/action.yaml manifest`
			);
			continue;
		}
		if (seen.has(manifest)) continue;
		seen.add(manifest);
		try {
			collectUsesFindings(findUses(readFileSync(manifest, 'utf8')), manifest, root, seen, findings);
		} catch (error) {
			findings.push(`${manifest}: invalid or unterminated YAML lexical state (${error.message})`);
		}
	}
}

export function validateActionPins(directory = workflowDirectory, root = '.') {
	const findings = [];
	const seen = new Set();
	for (const file of yamlFiles(directory)) {
		try {
			collectUsesFindings(findUses(readFileSync(file, 'utf8')), file, root, seen, findings);
		} catch (error) {
			findings.push(`${file}: invalid or unterminated YAML lexical state (${error.message})`);
		}
	}
	return findings;
}

/**
 * Every local composite action manifest reachable from the workflow set, found by
 * the same recursive `uses: ./` walk the pin scanner performs. `validateActionPins`
 * follows these to check what they *use*; the policy scans below follow them to
 * check what they *run*. A composite action's `run:` is a workflow's `run:` one
 * indirection later, and an indirection is not an exemption.
 */
export function localActionManifests(directory = workflowDirectory, root = '.') {
	const seen = new Set();
	const walk = (values) => {
		for (const value of values) {
			if (!value.startsWith('./')) continue;
			const manifest = resolveLocalAction(value, root);
			if (!manifest || seen.has(manifest)) continue;
			seen.add(manifest);
			try {
				walk(findUses(readFileSync(manifest, 'utf8')));
			} catch {
				// Unparseable manifests are already a finding in validateActionPins;
				// here they simply reach nothing further.
			}
		}
	};
	for (const file of yamlFiles(directory)) {
		try {
			walk(findUses(readFileSync(file, 'utf8')));
		} catch {
			// Same: the pin scanner owns reporting the lexical failure.
		}
	}
	return [...seen];
}

function disabledIfValue(value) {
	let resolved = scalar(value).trim();
	const expression = resolved.match(/^\$\{\{\s*(.*?)\s*\}\}$/s);
	if (expression) resolved = expression[1].trim();
	// Offline YAML coercion is not verifiable. Known false values disable; ambiguous
	// YAML 1.1-ish spellings deliberately disable too (fail closed). Quoted expressions
	// such as ${{ '0' }} remain live because GitHub evaluates them as expressions.
	if (resolved === '' || resolved === "''" || resolved === '""') return true;
	if (/^(?:false|null|~)$/i.test(resolved)) return true;
	if (/^(?:no|off|n|y|yes|on|0_0|0b0|0o0)$/i.test(resolved)) return true;
	return (
		/^[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/.test(resolved) &&
		Number(resolved) === 0
	);
}

// A sentinel-bearing step must run for this repository's required pull-request
// trigger.  Unlike a job-level condition, an unknown step condition cannot be
// evidence: retain only the tiny set we can prove true without evaluating
// GitHub expressions.
export function stepIfIsProvenTrue(value) {
	let resolved = scalar(value).trim();
	const expression = resolved.match(/^\$\{\{\s*(.*?)\s*\}\}$/s);
	if (expression) resolved = expression[1].trim();
	return (
		resolved === 'true' ||
		((/^'[^']*'$/.test(resolved) || /^"[^"]*"$/.test(resolved)) && resolved.length > 2) ||
		(/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(resolved) && Number(resolved) !== 0) ||
		/^(?:github\.event_name\s*==\s*['"]pull_request['"]|['"]pull_request['"]\s*==\s*github\.event_name)$/.test(
			resolved
		)
	);
}

function stripRunBlockComment(command, shellQuote = null) {
	let quote = shellQuote;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (quote) {
			if (character === quote && !(quote === '"' && escapedByOddBackslashes(command, index)))
				quote = null;
			continue;
		}
		// Outside a quote, a shell-escaped quote is ordinary data. ANSI-C ($'...')
		// and localized ($"...") quoting have escape semantics this small scanner
		// does not model, so make the rest of this block opaque rather than guessing.
		if ((character === '"' || character === "'") && escapedByOddBackslashes(command, index))
			continue;
		if ((character === '"' || character === "'") && index > 0 && command[index - 1] === '$') {
			quote = '$opaque';
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === '#' && (index === 0 || /\s/.test(command[index - 1])))
			return { command: command.slice(0, index).trimEnd(), quote };
	}
	return { command: command.trimEnd(), quote };
}

function heredocOperators(command) {
	const operators = [];
	const expansionMasked = maskArithmeticExpansions(command);
	let quote = null;
	for (let index = 0; index < command.length - 1; index += 1) {
		const character = expansionMasked[index];
		if (quote) {
			if (character === quote && !(quote === '"' && escapedByOddBackslashes(command, index)))
				quote = null;
			continue;
		}
		// Keep this quote/escape state exactly aligned with stripRunBlockComment:
		// an escaped bare quote is data, while ANSI-C/localized forms are opaque.
		if ((character === '"' || character === "'") && escapedByOddBackslashes(command, index))
			continue;
		if ((character === '"' || character === "'") && index > 0 && command[index - 1] === '$')
			return { operators, unrecognized: true };
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		// Shell heredocs begin at a command boundary. This excludes here-strings,
		// quoted text, and arithmetic shifts while retaining ordinary << / <<-.
		if (
			character === '<' &&
			expansionMasked[index + 1] === '<' &&
			expansionMasked[index + 2] !== '<' &&
			expansionMasked[index - 1] !== '<'
		)
			operators.push(index);
	}
	return { operators, unrecognized: false };
}

function heredocDelimiters(command, operators) {
	const delimiters = operators.map((operator) => {
		const source = command.slice(operator);
		const match = source.match(/^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2(?=$|[\s;|&])/);
		return match ? { delimiter: match[3], allowLeadingTabs: match[1] === '-' } : null;
	});
	return delimiters.every(Boolean) ? delimiters : null;
}

function isHeredocTerminator(rawBody, heredoc) {
	return heredoc.allowLeadingTabs
		? new RegExp(`^\\t*${heredoc.delimiter}$`).test(rawBody)
		: rawBody === heredoc.delimiter;
}

function isWorkflowStructureError(error) {
	if (!(error instanceof Error)) return false;
	return [
		'invalid block scalar header',
		'unterminated quoted scalar',
		'unexpected text after quoted scalar',
	].includes(error.message);
}

function yamlQuoteOpenedOnLine(line) {
	let cursor = 0;
	let comment = false;
	let valueBoundary = true;
	while (cursor < line.length) {
		const character = line[cursor];
		if (comment) return null;
		if (character === '#' && (cursor === 0 || /\s/.test(line[cursor - 1]))) {
			comment = true;
			continue;
		}
		if ((character === "'" || character === '"') && valueBoundary) {
			const quote = character;
			cursor += 1;
			for (; cursor < line.length; cursor += 1) {
				if (line[cursor] !== quote) continue;
				if (quote === "'" && line[cursor + 1] === "'") {
					cursor += 1;
					continue;
				}
				if (quote === '"' && escapedByOddBackslashes(line, cursor)) continue;
				break;
			}
			if (cursor === line.length) return quote;
			valueBoundary = false;
			cursor += 1;
			continue;
		}
		if (character === ':') valueBoundary = true;
		else if ((character === '&' || character === '*' || character === '!') && valueBoundary) {
			cursor += 1;
			while (/[^\s]/.test(line[cursor] ?? '')) cursor += 1;
			continue;
		} else if (!/\s/.test(character)) valueBoundary = false;
		cursor += 1;
	}
	return null;
}

function continueYamlQuote(line, quote) {
	for (let cursor = 0; cursor < line.length; cursor += 1) {
		if (line[cursor] !== quote) continue;
		if (quote === "'" && line[cursor + 1] === "'") {
			cursor += 1;
			continue;
		}
		if (quote === '"' && escapedByOddBackslashes(line, cursor)) continue;
		return null;
	}
	return quote;
}

function executableWorkflowText(content) {
	const lines = content.split(/\r\n|\r|\n/);
	let block = null;
	let yamlQuote = null;
	let jobs = null;
	const jobBlocks = [];
	let currentJob = null;
	let unsupportedShell = false;
	const jobKey = /^(?:[A-Za-z0-9_-]+|"[^"\r\n]+"|'[^'\r\n]+')\s*:\s*(?:#.*)?$/;
	const jobsKey = /^\s*(?:jobs|"jobs"|'jobs')\s*:\s*(.*)$/;
	const ifKey = /^\s*(?:if|"if"|'if')\s*:\s*(.*)$/;

	const finishJobs = () => {
		if (!jobs) return;
		// A block-form jobs map must yield at least one recognized job. Empty,
		// comment-only, and flow-form values cannot establish executable evidence.
		if (jobs.states.length === 0) jobs.unrecognized = true;
		jobBlocks.push(jobs);
		jobs = null;
		currentJob = null;
	};

	const pushExecutable = (job, step, command) => {
		// Only a recognized step owns executable command evidence. Job-level
		// run/uses is separately rejected by the unscoped sentinel; nested keys
		// such as defaults.run.shell or stages[].run are mapping data, not steps.
		if (!job || !command || step?.job !== job) return;
		step.executable.push(command);
	};
	const pushAction = (job, step, action) => {
		if (!job || !action || step?.job !== job) return;
		step.actionRefs.push(action);
	};
	const pushOpaque = (job, step, command) => {
		if (!job || !command) return;
		(step?.job === job ? step.opaque : job.opaque).push(command);
	};

	const processRunCommand = (runBlock, source) => {
		const wasQuoted = Boolean(runBlock.shellQuote);
		const stripped = stripRunBlockComment(source, runBlock.shellQuote);
		runBlock.shellQuote = stripped.quote;
		const command = stripped.command.trim();
		if (!command) return;
		// A physical line swallowed by an open shell quote is data, even when it
		// contains a command-looking token. The closing line is data too.
		if (wasQuoted || runBlock.shellQuote) {
			pushOpaque(runBlock.job, runBlock.step, command);
			return;
		}
		if (runBlock.heredoc) {
			if (!runBlock.heredoc.unrecognized && isHeredocTerminator(source, runBlock.heredoc[0])) {
				runBlock.heredoc.shift();
				if (!runBlock.heredoc.length) runBlock.heredoc = null;
			}
			return;
		}
		const heredocScan = heredocOperators(command);
		const delimiters = heredocDelimiters(command, heredocScan.operators);
		if (heredocScan.unrecognized || (heredocScan.operators.length && !delimiters))
			runBlock.heredoc = { unrecognized: true };
		else if (heredocScan.operators.length) runBlock.heredoc = delimiters;
		else runBlock.commands.push(command);
	};

	const foldedRun = (lines, contentIndent) =>
		lines
			.map(({ body }, index) => {
				if (index === 0) return body;
				const previous = lines[index - 1];
				return previous.blank ||
					lines[index].blank ||
					previous.indent > contentIndent ||
					lines[index].indent > contentIndent
					? `\n${body}`
					: ` ${body}`;
			})
			.join('');

	const processRunPhysicalLine = (runBlock, source) => {
		let command = source;
		if (runBlock.pendingContinuation) {
			command = `${runBlock.pendingContinuation.trimEnd().slice(0, -1)}${command}`;
			runBlock.pendingContinuation = null;
		}
		if (
			!runBlock.shellQuote &&
			!stripRunBlockComment(command).quote &&
			/\\+$/.test(command.trimEnd()) &&
			escapedByOddBackslashes(command.trimEnd(), command.trimEnd().length)
		) {
			runBlock.pendingContinuation = command;
			return;
		}
		processRunCommand(runBlock, command);
	};

	const finishBlock = () => {
		if (block?.kind === 'job-if' && !stepIfIsProvenTrue(block.valueLines.join(' ')))
			block.subject.disabled = true;
		if (block?.kind === 'step-if' && !stepIfIsProvenTrue(block.valueLines.join(' ')))
			block.subject.disabled = true;
		if (
			(block?.kind === 'job-continue-on-error' || block?.kind === 'step-continue-on-error') &&
			!disabledIfValue(block.valueLines.join(' '))
		)
			block.subject.disabled = true;
		if (block?.kind === 'run') {
			if (block.folded) {
				for (const physicalLine of foldedRun(block.lines, block.contentIndent).split('\n')) {
					processRunPhysicalLine(block, physicalLine);
				}
				if (block.pendingContinuation) processRunCommand(block, block.pendingContinuation);
			} else if (block.pendingContinuation) processRunCommand(block, block.pendingContinuation);
			if (block.commands.length) pushExecutable(block.job, block.step, block.commands.join('\n'));
		}
		block = null;
	};

	for (const line of lines) {
		const indentText = line.match(/^\s*/)[0];
		const indent = indentText.length;
		const nonBlank = /\S/.test(line);
		if (block && !nonBlank) {
			if (block.kind === 'run') {
				if (block.pendingContinuation) {
					processRunCommand(block, block.pendingContinuation);
					block.pendingContinuation = null;
				}
				if (block.folded) block.lines.push({ body: '', indent, blank: true });
			}
			continue;
		}
		if (block && nonBlank) {
			if (block.contentIndent === null && indent > block.headerIndent)
				block.contentIndent = block.explicitIndent ?? indent;
			if (block.contentIndent !== null && indent >= block.contentIndent) {
				const body = line.slice(block.contentIndent);
				if (block.kind === 'run') {
					if (/^\s*#/.test(body)) {
						if (block.pendingContinuation) {
							processRunCommand(block, block.pendingContinuation);
							block.pendingContinuation = null;
						}
						continue;
					}
					if (block.folded) {
						block.lines.push({ body, indent, blank: false });
						continue;
					}
					if (block.heredoc) {
						if (!block.heredoc.unrecognized && isHeredocTerminator(body, block.heredoc[0])) {
							block.heredoc.shift();
							if (!block.heredoc.length) block.heredoc = null;
						}
						continue;
					}
					processRunPhysicalLine(block, body);
				} else if (
					(block.kind === 'job-if' ||
						block.kind === 'job-continue-on-error' ||
						block.kind === 'step-continue-on-error') &&
					!/^\s*#/.test(body)
				) {
					block.valueLines.push(body.trim());
				}
				continue;
			}
			finishBlock(); // dedented keys are processed normally below.
		}

		// A physical continuation of a quoted YAML scalar is data, even if it
		// resembles a step key. Its closing physical line remains scalar data too.
		if (yamlQuote) {
			yamlQuote = continueYamlQuote(line, yamlQuote);
			continue;
		}

		// GitHub Actions preserves errexit only for its built-in bash/sh shell
		// templates. Custom shell strings are execution semantics outside this
		// deliberately small model, so every shell mapping must use that vocabulary.
		const shell = line.match(/^\s*(?:-\s*)?(?:shell|"shell"|'shell')\s*:\s*(.*)$/);
		if (shell) {
			const value = shell[1];
			if (blockScalarHeader(value.trimStart()) || !['bash', 'sh'].includes(scalar(value)))
				unsupportedShell = true;
		}
		// YAML flow mappings are semantically equivalent to their block spelling.
		// Scan every physical line because `run: {shell: ...}` need not begin with
		// its `shell` key; custom templates fall outside this shell model.
		for (const flowShell of line.matchAll(/[{,]\s*(?:shell|"shell"|'shell')\s*:\s*([^,}]*)/g)) {
			try {
				if (!['bash', 'sh'].includes(scalar(flowShell[1]))) unsupportedShell = true;
			} catch {
				// The flow token ends at its mapping delimiter; an unterminated scalar
				// in that slice is outside the model and therefore unsupported too.
				unsupportedShell = true;
			}
		}
		yamlQuote = yamlQuoteOpenedOnLine(line);

		const jobsMatch = line.match(jobsKey);
		// Only a root mapping key establishes the workflow jobs context. A service
		// container named jobs is data inside a job, never a second workflow map.
		if (jobsMatch && indent === 0) {
			finishJobs();
			jobs = { states: [], unrecognized: Boolean(jobsMatch[1] && !/^#/.test(jobsMatch[1].trim())) };
			continue;
		}
		if (jobs && indent <= 0 && nonBlank && !/^\s*#/.test(line)) finishJobs();
		if (jobs && indent > 0 && !/^\s*#/.test(line)) {
			jobs.childIndent ??= indent;
			if (
				indent === jobs.childIndent &&
				!indentText.includes('\t') &&
				jobKey.test(line.trimStart())
			) {
				currentJob = {
					disabled: false,
					indent,
					childIndent: null,
					opaque: [],
					steps: [],
					stepsIndent: null,
					stepsSequenceIndent: null,
					currentStep: null,
					unscopedRun: false,
				};
				jobs.states.push(currentJob);
				continue;
			}
		}

		// A job condition is only a direct mapping child of its job. Step,
		// strategy, and with conditions are execution-local and cannot establish
		// that the job itself is disabled.
		if (currentJob && indent > currentJob.indent && nonBlank && !/^\s*#/.test(line)) {
			currentJob.childIndent ??= indent;
			if (indent === currentJob.childIndent) {
				const condition = line.match(ifKey);
				if (condition) {
					const value = condition[1];
					const blockHeader = blockScalarHeader(value.trimStart());
					if (blockHeader) {
						block = {
							kind: 'job-if',
							subject: currentJob,
							headerIndent: indent,
							explicitIndent:
								blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
							contentIndent: null,
							valueLines: [],
						};
						continue;
					}
					if (!stepIfIsProvenTrue(value)) currentJob.disabled = true;
				}
				const continueOnError = line.match(
					/^\s*(?:continue-on-error|"continue-on-error"|'continue-on-error')\s*:\s*(.*)$/
				);
				if (continueOnError) {
					const value = continueOnError[1];
					const blockHeader = blockScalarHeader(value.trimStart());
					if (blockHeader) {
						block = {
							kind: 'job-continue-on-error',
							subject: currentJob,
							headerIndent: indent,
							explicitIndent:
								blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
							contentIndent: null,
							valueLines: [],
						};
						continue;
					}
					if (!disabledIfValue(value)) currentJob.disabled = true;
				}
				if (/^(?:steps|"steps"|'steps')\s*:\s*(?:#.*)?$/.test(line.trimStart())) {
					currentJob.stepsIndent = indent;
					currentJob.stepsSequenceIndent = null;
				}
			}
		}

		const stepStart =
			currentJob &&
			currentJob.stepsIndent !== null &&
			indent >= currentJob.stepsIndent &&
			(currentJob.stepsSequenceIndent === null || indent === currentJob.stepsSequenceIndent)
				? line.match(/^\s*-\s*(.*)$/)
				: null;
		// YAML permits an indentationless sequence as a mapping value, so a step
		// may begin at the same indentation as `steps:`. Only a non-sequence line
		// at that level closes the current step.
		if (
			currentJob &&
			currentJob.stepsIndent !== null &&
			indent <= currentJob.stepsIndent &&
			!stepStart
		)
			currentJob.currentStep = null;
		if (currentJob && currentJob.stepsIndent !== null && indent >= currentJob.stepsIndent) {
			if (stepStart) {
				// Once the steps sequence indent is known, deeper `-` entries are data
				// inside the current step (for example env/with lists), never new steps.
				currentJob.stepsSequenceIndent ??= indent;
				currentJob.currentStep = {
					job: currentJob,
					disabled: false,
					executable: [],
					actionRefs: [],
					opaque: [],
					keyIndent: null,
					keys: new Set(),
					duplicateKeys: false,
				};
				currentJob.steps.push(currentJob.currentStep);
				const condition = stepStart[1].match(ifKey);
				if (condition) {
					const value = condition[1];
					const blockHeader = blockScalarHeader(value.trimStart());
					if (blockHeader) {
						block = {
							kind: 'step-if',
							subject: currentJob.currentStep,
							headerIndent: indent,
							explicitIndent:
								blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
							contentIndent: null,
							valueLines: [],
						};
						continue;
					}
					if (!stepIfIsProvenTrue(value)) currentJob.currentStep.disabled = true;
				}
			} else if (currentJob.currentStep) {
				const condition = line.match(ifKey);
				if (condition) {
					const value = condition[1];
					const blockHeader = blockScalarHeader(value.trimStart());
					if (blockHeader) {
						block = {
							kind: 'step-if',
							subject: currentJob.currentStep,
							headerIndent: indent,
							explicitIndent:
								blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
							contentIndent: null,
							valueLines: [],
						};
						continue;
					}
					if (!stepIfIsProvenTrue(value)) currentJob.currentStep.disabled = true;
				}
			}
		}

		if (currentJob?.currentStep) {
			const stepKey = line.match(/^\s*(?:-\s*)?([^:#][^:]*):\s*(.*)$/);
			if (stepKey) {
				const isSequenceKey = /^\s*-/.test(line);
				const step = currentJob.currentStep;
				if (isSequenceKey || step.keyIndent === null) step.keyIndent = indent;
				if (indent === step.keyIndent || (!isSequenceKey && indent === step.keyIndent + 2)) {
					const key = scalar(stepKey[1]);
					if (step.keys.has(key)) step.duplicateKeys = true;
					step.keys.add(key);
					if (key === 'continue-on-error') {
						const value = stepKey[2];
						const blockHeader = blockScalarHeader(value.trimStart());
						if (blockHeader) {
							block = {
								kind: 'step-continue-on-error',
								subject: step,
								headerIndent: indent,
								explicitIndent:
									blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
								contentIndent: null,
								valueLines: [],
							};
							continue;
						}
						if (!disabledIfValue(value)) step.disabled = true;
					}
				}
			}
		}

		const run = line.match(/^\s*(?:-\s*)?run:\s*(.*)$/);
		if (run) {
			if (
				currentJob?.currentStep &&
				currentJob.currentStep.keyIndent !== null &&
				indent !== currentJob.currentStep.keyIndent &&
				indent !== currentJob.currentStep.keyIndent + 2
			)
				currentJob.currentStep.duplicateKeys = true;
			const value = scalar(run[1]);
			if (
				currentJob &&
				!currentJob.currentStep &&
				currentJob.stepsIndent === null &&
				indent === currentJob.childIndent
			)
				currentJob.unscopedRun = true;
			const blockHeader = blockScalarHeader(value);
			if (blockHeader) {
				block = {
					kind: 'run',
					job: currentJob,
					step: currentJob?.currentStep,
					headerIndent: indent,
					explicitIndent:
						blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
					contentIndent: null,
					heredoc: null,
					folded: value.startsWith('>'),
					lines: [],
					pendingContinuation: null,
					shellQuote: null,
					commands: [],
				};
			} else if (
				currentJob?.currentStep &&
				(indent === currentJob.currentStep.keyIndent ||
					indent === currentJob.currentStep.keyIndent + 2)
			) {
				// Do not unescape double-quoted YAML shell text; backslashes are opaque.
				if (/^"/.test(run[1].trimStart()) && /\\/.test(value))
					pushOpaque(currentJob, currentJob.currentStep, value);
				else pushExecutable(currentJob, currentJob.currentStep, value);
			}
		}
		const action = line.match(/^\s*(?:-\s*)?uses:\s*(.*)$/);
		if (action) {
			if (
				currentJob?.currentStep &&
				currentJob.currentStep.keyIndent !== null &&
				indent !== currentJob.currentStep.keyIndent &&
				indent !== currentJob.currentStep.keyIndent + 2
			)
				currentJob.currentStep.duplicateKeys = true;
			if (
				currentJob &&
				!currentJob.currentStep &&
				currentJob.stepsIndent === null &&
				indent === currentJob.childIndent
			)
				currentJob.unscopedRun = true;
			if (
				currentJob?.currentStep &&
				(indent === currentJob.currentStep.keyIndent ||
					indent === currentJob.currentStep.keyIndent + 2)
			)
				pushAction(currentJob, currentJob.currentStep, scalar(action[1]));
		}
		const genericBlock = run ? null : line.match(/^\s*(?:-\s*)?[^:#][^:]*:\s*(.*)$/);
		if (genericBlock) {
			const blockHeader = blockScalarHeader(genericBlock[1]);
			if (blockHeader) {
				block = {
					kind: 'other',
					headerIndent: indent,
					explicitIndent:
						blockHeader.explicitIndent === null ? null : indent + blockHeader.explicitIndent,
					contentIndent: null,
				};
			}
		}
	}
	if (block) finishBlock();
	finishJobs();
	return {
		executable: jobBlocks
			.flatMap((jobBlock) =>
				jobBlock.states
					.filter((job) => !job.disabled)
					.flatMap((job) => [
						...job.steps.filter((step) => !step.disabled).flatMap((step) => step.executable),
					])
			)
			.join('\u0000'),
		actionRefs: jobBlocks
			.flatMap((jobBlock) =>
				jobBlock.states
					.filter((job) => !job.disabled)
					.flatMap((job) =>
						job.steps.filter((step) => !step.disabled).flatMap((step) => step.actionRefs)
					)
			)
			.join('\n'),
		opaque: jobBlocks
			.flatMap((jobBlock) =>
				jobBlock.states
					.filter((job) => !job.disabled)
					.flatMap((job) => [
						...job.steps.filter((step) => !step.disabled).flatMap((step) => step.opaque),
					])
			)
			.join('\n'),
		allJobsDisabled: jobBlocks.some(
			(jobBlock) => jobBlock.states.length > 0 && jobBlock.states.every((job) => job.disabled)
		),
		noLiveRecognizedSteps: jobBlocks.some(
			(jobBlock) =>
				!jobBlock.states.some((job) => !job.disabled && job.steps.some((step) => !step.disabled))
		),
		unsupportedShell,
		unrecognizedJobStructure: jobBlocks.some(
			(jobBlock) =>
				jobBlock.unrecognized ||
				jobBlock.states.some(
					(job) =>
						!job.disabled && (job.unscopedRun || job.steps.some((step) => step.duplicateKeys))
				)
		),
	};
}

// A non-whitespace, non-operator stand-in retains shell-token boundaries while
// hiding opaque text from the simple command splitter below.
const shellOpaquePlaceholder = '\u0001';

function maskShellQuotedSpans(command) {
	const masked = [...command];
	let quote = null;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (quote) {
			masked[index] = shellOpaquePlaceholder;
			if (character === quote && !(quote === '"' && escapedByOddBackslashes(command, index)))
				quote = null;
			continue;
		}
		if ((character === '"' || character === "'") && escapedByOddBackslashes(command, index))
			continue;
		if ((character === '"' || character === "'") && index > 0 && command[index - 1] === '$') {
			for (let cursor = index; cursor < command.length; cursor += 1)
				masked[cursor] = shellOpaquePlaceholder;
			break;
		}
		// Backticks open a command substitution. Keep its bytes visible only to
		// preserve offsets; the executable matcher rejects every backtick-bearing
		// command, so substitutions can never establish sentinel evidence.
		if (character === '`' && !escapedByOddBackslashes(command, index)) {
			for (let cursor = index + 1; cursor < command.length; cursor += 1) {
				if (command[cursor] !== '`' || escapedByOddBackslashes(command, cursor)) continue;
				masked[cursor] = ' ';
				index = cursor;
				break;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			masked[index] = shellOpaquePlaceholder;
			quote = character;
			continue;
		}
		// A single unquoted backslash quotes its next byte. Keep both bytes opaque:
		// otherwise an escaped `;` or `|` becomes a phantom command boundary.
		if (
			character === '\\' &&
			!escapedByOddBackslashes(command, index) &&
			index + 1 < command.length &&
			command[index + 1] !== '\n'
		) {
			masked[index] = masked[index + 1] = shellOpaquePlaceholder;
			index += 1;
		}
	}
	// An unterminated quote makes the remainder opaque; it must never reopen a
	// command boundary on a later matcher pass.
	if (quote) {
		for (let index = 0; index < masked.length; index += 1) masked[index] = shellOpaquePlaceholder;
	}
	return masked.join('');
}

function maskArithmeticExpansions(command) {
	const masked = [...command];
	for (let index = 0; index < command.length - 2; index += 1) {
		if (command.slice(index, index + 3) !== '$((') continue;
		masked[index] = masked[index + 1] = masked[index + 2] = ' ';
		let depth = 1;
		for (let cursor = index + 3; cursor < command.length - 1; cursor += 1) {
			masked[cursor] = ' ';
			if (command.slice(cursor, cursor + 2) === '((') depth += 1;
			if (command.slice(cursor, cursor + 2) === '))') {
				depth -= 1;
				masked[cursor + 1] = ' ';
				if (!depth) {
					index = cursor + 1;
					break;
				}
			}
		}
	}
	return masked.join('');
}

const execSentinels = new Set([
	'pnpm test',
	'pnpm run lint',
	'bash gov-infra/verifiers/gov-verify-rubric.sh',
	'node gov-infra/verifiers/install-greater-cli.mjs',
	'test "${BASE_REF}" = main',
	'test "${HEAD_REF}" = staging',
	'test "${HEAD_REPOSITORY}" = "${CURRENT_REPOSITORY}"',
]);
const reservedWords = new Set(
	'if then else elif fi for do done while until case esac select coproc function in { } ( ) ! [ [['.split(
		' '
	)
);
const unmodelledHeads = new Set(
	'exit exec eval trap alias unalias shopt hash builtin command enable source . return break continue declare typeset readonly local let export read printf mapfile readarray getopts time env'.split(
		' '
	)
);
const safeSetOptions = new Set([
	'pipefail',
	'errexit',
	'nounset',
	'xtrace',
	'errtrace',
	'functrace',
]);
const allowedPrefixAssignmentNames = new Set(['CI', 'VAR']);
const assignmentPrefix = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)[^\s;|&()]*[ \t]+/;
const assignmentStart = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)[^\s;|&()]*(?:[ \t]+|$)/;

function unsupportedPrefixAssignment(segment) {
	let source = stripOutputRedirections(segment.trim());
	while (source) {
		const assignment = source.match(assignmentStart);
		if (assignment) {
			if (assignment[2] !== '=' || !allowedPrefixAssignmentNames.has(assignment[1])) return true;
			source = source.slice(assignment[0].length);
			continue;
		}
		const decorator = source.match(/^(?:time|env)[ \t]+/);
		if (decorator) {
			source = source.slice(decorator[0].length).trimStart();
			continue;
		}
		return false;
	}
	return false;
}

// This is the sole decoration reduction used for both exact sentinel evidence
// and the command head that must remain modelled.
function reducedSegment(segment) {
	let source = stripOutputRedirections(segment.trim());
	let changed = true;
	while (changed) {
		changed = false;
		const assignment = source.match(assignmentPrefix);
		if (assignment && assignment[2] === '=' && allowedPrefixAssignmentNames.has(assignment[1])) {
			source = source.slice(assignment[0].length);
			changed = true;
			continue;
		}
		const decorator = source.match(/^(?:time|env)[ \t]+/);
		if (decorator) {
			source = source.slice(decorator[0].length).trimStart();
			changed = true;
		}
	}
	return source;
}

function resolvedHead(segment) {
	return reducedSegment(segment).split(/\s+/)[0];
}

function setIsCosmetic(segment) {
	const args = reducedSegment(segment).split(/\s+/).slice(1);
	const safePlusSetOptions = new Set(['xtrace', 'nounset', 'errtrace', 'functrace']);
	for (let index = 0; index < args.length; index += 1) {
		const match = args[index].match(/^[-+]([a-zA-Z]*)$/);
		if (!match) return false;
		const positive = match[0][0] === '-';
		if (!(positive ? /^[euxET]*o?$/ : /^[uxET]*o?$/).test(match[1])) return false;
		if (match[1].endsWith('o')) {
			index += 1;
			if (!(positive ? safeSetOptions : safePlusSetOptions).has(args[index])) return false;
		}
	}
	return true;
}

function altersControlOrResolution(segment) {
	if (unsupportedPrefixAssignment(segment)) return true;
	const head = resolvedHead(segment);
	// Quotes and escaped bytes are intentionally opaque to the small shell
	// model.  If they reach the head, bash may still resolve a control builtin;
	// fail closed rather than treating the rewritten token as harmless.
	if (head.includes(shellOpaquePlaceholder)) return true;
	if (unmodelledHeads.has(head)) return true;
	return head === 'set' && !setIsCosmetic(segment);
}

function stripOutputRedirections(segment) {
	return segment
		.replace(/[ \t]+\d?>&\d\s*$/g, '')
		.replace(/[ \t]+(?:\d?>|\d?>>)(?:\s*[^\s;|&]+)?\s*$/g, '')
		.trim();
}

function exactSentinelSegment(segment, sentinel) {
	return reducedSegment(segment) === sentinel;
}

function enablesPipefail(segment) {
	const args = reducedSegment(segment).split(/\s+/).slice(1);
	for (let index = 0; index < args.length; index += 1) {
		const match = args[index].match(/^-([a-zA-Z]*)$/);
		if (match?.[1].endsWith('o') && args[index + 1] === 'pipefail') return true;
	}
	return false;
}

function splitMaskedSegments(masked) {
	const segments = [];
	let start = 0;
	const separators = /;|&&|\|/g;
	for (let match; (match = separators.exec(masked));) {
		segments.push([start, match.index]);
		start = match.index + match[0].length;
	}
	segments.push([start, masked.length]);
	return segments;
}

function sentinelIsExecutable(script, sentinel) {
	if (!execSentinels.has(sentinel)) return script.includes(sentinel);
	// C14-5 withdrawal: `true ||` can exit 0 without invoking its right side,
	// unlike `false &&` (which exits 1); silent-bypass asymmetry requires a
	// whole-script, fail-closed rule rather than boundary matching.
	return script.split('\u0000').some((oneScript) => {
		const masked = maskArithmeticExpansions(maskShellQuotedSpans(oneScript));
		if (/[`]|\$\(|\|\||[(){}]/.test(masked)) return false;
		const lines = masked.split('\n');
		const rawLines = oneScript.split('\n');
		let seen = false;
		let pipefailEnabled = false;
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const line = lines[lineIndex];
			const rawLine = rawLines[lineIndex];
			if (!line.trim()) continue;
			const segments = splitMaskedSegments(line);
			if (!line.slice(...segments[segments.length - 1]).trim() && /;\s*$/.test(line))
				segments.pop();
			// Anything not split by the allowed joiners (including a lone &, redirects
			// in the middle, or malformed operators) leaves an illegal token behind.
			if (
				segments.some(([start, end]) =>
					stripOutputRedirections(line.slice(start, end)).includes('&')
				) ||
				segments.some(([start, end]) =>
					/(^|\s)(?:\|\||&|<<|>>?|\d?>&\d)(?=\s|$)/.test(
						stripOutputRedirections(line.slice(start, end))
					)
				)
			)
				return false;
			for (const [start, end] of segments) {
				const segment = line.slice(start, end).trim();
				// Masking retains byte-for-byte offsets.  Boundaries and safety checks
				// stay on the masked form, while exact executable text is checked on
				// raw shell source so quoted variable references remain attestable.
				const rawSegment = rawLine.slice(start, end).trim();
				if (!segment) return false;
				const first = segment.split(/\s+/)[0];
				if (reservedWords.has(first) || altersControlOrResolution(segment)) return false;
				if (exactSentinelSegment(rawSegment, sentinel)) {
					if (line.slice(end).startsWith('|') && !pipefailEnabled) return false;
					seen = true;
				}
				if (resolvedHead(segment) === 'set' && enablesPipefail(segment)) pipefailEnabled = true;
			}
		}
		return seen;
	});
}

export function validateRequiredWorkflows(
	directory = workflowDirectory,
	scanner = executableWorkflowText
) {
	const findings = [];
	for (const [name, sentinels] of Object.entries(requiredWorkflows)) {
		const file = join(directory, name);
		if (!existsSync(file) || !statSync(file).isFile()) {
			findings.push(`${file}: required workflow missing or not a regular file`);
			continue;
		}
		try {
			const {
				executable,
				actionRefs = '',
				opaque = '',
				allJobsDisabled,
				noLiveRecognizedSteps,
				unsupportedShell,
				unrecognizedJobStructure,
			} = scanner(readFileSync(file, 'utf8'));
			if (unsupportedShell)
				findings.push(`${file}: unsupported shell mapping (only bash or sh are modelled)`);
			if (unrecognizedJobStructure)
				findings.push(`${file}: unrecognized job structure under top-level jobs mapping`);
			if (noLiveRecognizedSteps)
				findings.push(`${file}: no recognized live steps under top-level jobs mapping`);
			if (allJobsDisabled) findings.push(`${file}: all jobs are disabled by if: false`);
			// An all-disabled map already fails closed; otherwise each sentinel must
			// be evidenced by a recognized live job, never top-level or skipped data.
			if (!allJobsDisabled)
				for (const sentinel of sentinels) {
					if (
						!(sentinel === 'github/codeql-action/init@'
							? actionRefs.includes(sentinel)
							: sentinelIsExecutable(executable, sentinel)) &&
						!(
							!execSentinels.has(sentinel) &&
							sentinel !== 'github/codeql-action/init@' &&
							opaque.includes(sentinel)
						)
					)
						findings.push(
							`${file}: required workflow executable sentinel missing (${sentinel})${/\bcase\b/.test(executable) ? '; case syntax is unsupported' : ''}`
						);
				}
		} catch (error) {
			if (!isWorkflowStructureError(error)) throw error;
			findings.push(`${file}: invalid workflow structure (${error.message})`);
		}
	}
	return findings;
}

export function validatePullRequestTriggers(directory = workflowDirectory) {
	const findings = [];
	for (const file of yamlFiles(directory)) {
		const lines = readFileSync(file, 'utf8').split(/\r\n|\r|\n/);
		const onBlocks = lines
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => /^on:\s*(?:#.*)?$/.test(line));
		if (onBlocks.length !== 1) {
			findings.push(`${file}: expected exactly one block-form on:, found ${onBlocks.length}`);
			continue;
		}
		const keys = new Set();
		let childIndent;
		for (let index = onBlocks[0].index + 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line.trim() || /^\s*#/.test(line)) continue;
			const indent = line.match(/^\s*/)[0].length;
			if (indent === 0) break;
			if (childIndent === undefined) childIndent = indent;
			if (indent < childIndent) break;
			if (indent === childIndent) {
				const match = line.match(/^\s*([^:#][^:]*):/);
				if (!match) {
					findings.push(`${file}:${index + 1}: malformed on: trigger`);
					break;
				}
				keys.add(match[1].trim());
			}
		}
		if (keys.size !== 1 || !keys.has('pull_request'))
			findings.push(
				`${file}: trigger keys must be exactly {pull_request}; got {${[...keys].join(', ')}}`
			);
	}
	return findings;
}

/**
 * One structural pass that yields the mapping lines outside block scalars, the
 * text of every `run:` value, and the body of every block scalar by its header
 * line. The consumers below need to tell a mapping key from shell text; a
 * `permissions:` line inside a script is not a permissions block, and a `${{ }}`
 * in a comment above a job is not an injected command. `blockTexts` exists so an
 * `env:` entry whose value is a block scalar is read rather than skipped: a value
 * this pass cannot see is a value the env-sink rule below cannot judge.
 */
function scanWorkflowLines(content) {
	const lines = content.split(/\r\n|\r|\n/);
	const mappingLines = [];
	const runTexts = [];
	const blockTexts = new Map();
	let block = null;
	const closeBlock = () => {
		if (!block) return;
		const text = block.body.join('\n');
		blockTexts.set(block.headerLine, { key: block.key, text });
		// A block scalar's body is already shell text; an inline `run:` value is a
		// YAML scalar and its quoting comes off first, so the two are distinguished.
		if (block.isRun) runTexts.push({ line: block.headerLine, text, inlineScalar: false });
		block = null;
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const indent = line.match(/^\s*/)[0].length;
		const nonBlank = /\S/.test(line);
		if (block) {
			if (!nonBlank) {
				block.body.push('');
				continue;
			}
			if (block.contentIndent === null && indent > block.headerIndent)
				block.contentIndent = block.explicitIndent ?? indent;
			if (block.contentIndent !== null && indent >= block.contentIndent) {
				block.body.push(line.slice(block.contentIndent));
				continue;
			}
			closeBlock();
		}
		if (!nonBlank || /^\s*#/.test(line)) continue;
		const mapping = line.match(/^\s*(?:-\s*)?([^:#]+?)\s*:\s*(.*)$/);
		if (!mapping) continue;
		const key = mapping[1].replace(/^['"]|['"]$/g, '');
		const rawValue = mapping[2];
		mappingLines.push({ index, indent, line, key, rawValue });
		let header = null;
		try {
			header = blockScalarHeader(rawValue.trimStart());
		} catch {
			// An invalid block scalar header is already a finding in the pin scanner;
			// here it only means this line opens nothing we can attribute.
		}
		if (header) {
			block = {
				headerIndent: indent,
				headerLine: index,
				explicitIndent: header.explicitIndent === null ? null : indent + header.explicitIndent,
				contentIndent: null,
				key,
				isRun: key === 'run',
				body: [],
			};
			continue;
		}
		if (key === 'run' && rawValue.trim())
			runTexts.push({ line: index, text: rawValue, inlineScalar: true });
	}
	closeBlock();
	return { mappingLines, runTexts, blockTexts };
}

const READ_ONLY_VALUES = new Set(['read', 'none']);

function permissionEntries(mappingLines, position) {
	const declaration = mappingLines[position];
	const value = declaration.rawValue.replace(/\s+#.*$/, '').trim();
	if (value === '') {
		const entries = [];
		for (let index = position + 1; index < mappingLines.length; index += 1) {
			const child = mappingLines[index];
			if (child.indent <= declaration.indent) break;
			const scalar = child.rawValue.replace(/\s+#.*$/, '').trim();
			if (!/^[A-Za-z][A-Za-z-]*$/.test(child.key) || !/^[a-z-]+$/.test(scalar))
				return { error: `unreadable permission entry \`${child.line.trim()}\`` };
			entries.push({ scope: child.key, value: scalar });
		}
		if (!entries.length) return { error: 'empty block-form permissions:' };
		return { entries };
	}
	if (value === '{}') return { entries: [] };
	if (value === 'read-all') return { entries: [], readAll: true };
	if (value === 'write-all') return { error: 'permissions: write-all' };
	const flow = value.match(/^\{(.*)\}$/s);
	if (flow) {
		const entries = [];
		for (const pair of flow[1].split(',')) {
			if (!pair.trim()) continue;
			const parts = pair.split(':');
			if (parts.length !== 2) return { error: `unreadable flow permission \`${pair.trim()}\`` };
			const scope = parts[0].trim().replace(/^['"]|['"]$/g, '');
			const scalar = parts[1].trim().replace(/^['"]|['"]$/g, '');
			if (!/^[A-Za-z][A-Za-z-]*$/.test(scope) || !/^[a-z-]+$/.test(scalar))
				return { error: `unreadable flow permission \`${pair.trim()}\`` };
			entries.push({ scope, value: scalar });
		}
		return { entries };
	}
	return { error: `unreadable permissions value \`${value}\`` };
}

/**
 * Every workflow declares an explicit top-level `permissions:` block, and no scope
 * anywhere in the file — top-level or job-level — grants write, unless that exact
 * (workflow, scope, value) triple is pinned. Absent means "inherit the repository
 * default", which is a setting somebody can change without touching this repository.
 */
export function validateWorkflowPermissions(
	directory = workflowDirectory,
	allowedWrites = [],
	fileLabel = (file) => file.split('/').pop()
) {
	const findings = [];
	const allowed = new Set(
		allowedWrites.map((entry) => `${entry.workflow} ${entry.scope} ${entry.value}`)
	);
	for (const file of yamlFiles(directory)) {
		const { mappingLines } = scanWorkflowLines(readFileSync(file, 'utf8'));
		const declarations = mappingLines
			.map((mapping, position) => ({ mapping, position }))
			.filter(({ mapping }) => mapping.key === 'permissions');
		if (!declarations.some(({ mapping }) => mapping.indent === 0)) {
			findings.push(
				`${file}: no explicit top-level permissions: block; the workflow would inherit the repository default`
			);
			continue;
		}
		for (const { mapping, position } of declarations) {
			const parsed = permissionEntries(mappingLines, position);
			if (parsed.error) {
				findings.push(`${file}:${mapping.index + 1}: ${parsed.error}`);
				continue;
			}
			for (const { scope, value } of parsed.entries) {
				if (READ_ONLY_VALUES.has(value)) continue;
				if (allowed.has(`${fileLabel(file)} ${scope} ${value}`)) continue;
				findings.push(
					`${file}:${mapping.index + 1}: permission ${scope}: ${value} is not read/none and is not a pinned exception`
				);
			}
		}
	}
	return findings;
}

/**
 * `${{ github.event.* }}` inside a `run:` block is attacker-authored text spliced
 * into the script before the shell parses it — a PR title closing the quote runs
 * whatever follows. The accepted pattern, used by every workflow here, is to pass
 * the value through `env:` and reference it as a shell variable.
 */
export function validateRunExpressions(directory = workflowDirectory, root = '.') {
	const findings = [];
	for (const file of [...yamlFiles(directory), ...localActionManifests(directory, root)]) {
		const { runTexts } = scanWorkflowLines(readFileSync(file, 'utf8'));
		for (const { line, text } of runTexts) {
			for (const [expression, body] of text.matchAll(/\$\{\{([^}]*)\}\}/g)) {
				if (!/\bgithub\s*\.\s*event\b/.test(body)) continue;
				findings.push(
					`${file}:${line + 1}: run: interpolates ${expression.trim()} directly; ` +
						'pass it through env: and reference the shell variable instead'
				);
			}
		}
	}
	return findings;
}

/**
 * The rule above forbids splicing event payload text into a `run:` block and tells
 * the author to pass it through `env:` instead. That advice is sound and it was
 * also, on its own, a hole: `env:` puts the value in the shell's environment, and
 * a shell that is handed its own environment back as *program text* is exactly as
 * compromised as one that had the text spliced in.
 *
 *     env:
 *       PAYLOAD: ${{ github.event.pull_request.title }}
 *     run: bash -c "$PAYLOAD"
 *
 * No `${{ }}` appears in that `run:`, so the previous scan passed it, and a pull
 * request title runs as a command before the rubric starts. Env indirection is
 * safe only where the value is consumed as *data*.
 *
 * So two rules, both applied to workflows and to every local composite action a
 * workflow reaches:
 *
 *   - A composite action manifest may not carry a `github.event` expression in
 *     `env:` at all. Composites receive their data through `with:` inputs; an
 *     event expression inside one is the workflow's trust boundary re-crossed at a
 *     depth the calling workflow's own review does not show.
 *   - That `with:` channel is allowed because the value arrives as *data*, so the
 *     same distinction applies to it. `${{ inputs.* }}` spliced straight into a
 *     composite's `run:` is caller-supplied text becoming program text — the very
 *     shape the event-expression rule exists to refuse, one indirection along — and
 *     is a finding. Carrying an input through `env:` is the safe pattern and stays
 *     allowed; the value is then tainted for the sink rule below, because what the
 *     caller passed may well be event payload.
 *   - An env value carrying a `github.event` expression may not be referenced from
 *     an executable sink in any `run:` text: `bash -c`/`sh -c`, `eval`, `node -e`,
 *     `python -c` and their siblings, `source`/`.`, an interpreter fed its program
 *     on standard input, a command substitution, or the command word of a segment.
 *     Referencing it as data — as an argument to a non-executing command, or as
 *     argv to a pinned script — stays exactly as allowed as before, because that is
 *     the pattern this repository's own workflows use.
 *
 * A sink is identified by what a segment *executes*, never by the word it starts
 * with, and — since three successive rounds of this rule each lost to a spelling it
 * had not enumerated — never by spelling at all. Quoting and backslashes rewrite the
 * executing word (`"bash"`, `b\ash`); assignment, empty-expansion and redirection
 * prefixes move it off the front (`FOO=bar bash`, `$UNSET bash`, `> /dev/null bash`);
 * `!`, subshells and keyword compounds put it after a grammar token (`( bash … )`,
 * `if …; then bash …`); and a variable can be the word itself (`VAR=bash; $VAR -c`).
 * A rule that enumerates sink spellings cannot win against a grammar, so the standard
 * of proof is inverted: the scanner must PROVE a segment safe, and a segment it
 * cannot resolve is a finding. See `lexShellScript` for what that parse covers.
 *
 * Taint follows shell assignment and same-line `$GITHUB_ENV` writes, to a fixpoint,
 * so renaming a value does not launder it. What it does not follow is recorded as a
 * residual limit in the threat model rather than implied to be covered: this reads
 * `run:` text, so a value that reaches a sink inside a called script, through a
 * pipe, or through a heredoc written to `$GITHUB_ENV` is outside it.
 */
const eventExpressionPattern = /\$\{\{([^}]*)\}\}/g;
const shellIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shellInterpreters = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh']);
const inlineScriptFlags = new Map([
	['node', /^(?:-e|--eval|-p|--print)$/],
	['nodejs', /^(?:-e|--eval|-p|--print)$/],
	['python', /^-c$/],
	['python3', /^-c$/],
	['perl', /^-[eE]$/],
	['ruby', /^-e$/],
]);
const assignmentDeclarators = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);

// A wrapper that launches another command: what runs is what follows it, so a rule
// that reads the word a segment starts with reads the wrapper and misses the sink.
const launcherWrappers = new Set([
	'builtin',
	'command',
	'doas',
	'env',
	'exec',
	'ionice',
	'nice',
	'nohup',
	'setsid',
	'stdbuf',
	'sudo',
	'time',
	'timeout',
	'xargs',
]);

// `source` and `.` name the program to run rather than pass an argument to one.
const sourceCommands = new Set(['source', '.']);

// Interpreters that take their program from standard input when given no script
// operand, so text fed to one there is program text and not the operand's data.
const stdinInterpreters = new Set([...shellInterpreters, ...inlineScriptFlags.keys()]);
const interpreterWords = new Set([...stdinInterpreters, ...sourceCommands, 'eval']);

// An operand naming a script means stdin belongs to that script: `bash pinned.sh
// <<< "$VALUE"` feeds data to a called script, which this model records as a
// residual rather than judges. A word that is neither a path nor a script name
// does not suppress the rule, so an option's value cannot pose as an operand.
// A name that *is* standard input takes nothing away, so `bash /dev/stdin <<<
// "$VALUE"` and `bash --rcfile /dev/stdin <<< "$VALUE"` remain the interpreter
// reading its own program.
const scriptOperand = /\/|\.(?:sh|bash|dash|zsh|ksh|js|mjs|cjs|ts|py|rb|pl)$/;
const standardInputNames = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

const eventReference = /\bgithub\s*\.\s*event\b/;
const inputReference = /\binputs\s*\.\s*[A-Za-z_-]/;

function expressionsMatching(text, pattern) {
	const found = [];
	for (const [expression, body] of String(text).matchAll(eventExpressionPattern))
		if (pattern.test(body)) found.push(expression.trim());
	return found;
}

const eventExpressionsIn = (text) => expressionsMatching(text, eventReference);
const inputExpressionsIn = (text) => expressionsMatching(text, inputReference);

// `$NAME`, `${NAME}`, `${NAME:-default}`. `${!NAME}` is deliberately not matched:
// indirect expansion is outside this model and is recorded as such.
function referencesVariable(token, name) {
	return new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(token);
}

function splitFlowEntries(source) {
	const entries = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") quote = character;
		else if ('{[('.includes(character)) depth += 1;
		else if ('}])'.includes(character)) depth -= 1;
		else if (character === ',' && depth === 0) {
			entries.push(source.slice(start, index));
			start = index + 1;
		}
	}
	entries.push(source.slice(start));
	return entries.filter((entry) => entry.trim());
}

// An env value that is a block scalar lives in `blockTexts`, not on the mapping
// line. Comments are deliberately not stripped: a value this pass mis-trims is a
// value it would then mis-judge, and over-reading a trailing comment fails closed.
function envValueOf(mapping, blockTexts) {
	let header = null;
	try {
		header = blockScalarHeader(mapping.rawValue.trimStart());
	} catch {
		header = null;
	}
	return header ? (blockTexts.get(mapping.index)?.text ?? '') : mapping.rawValue.trim();
}

function envDeclarations(mappingLines, blockTexts) {
	const entries = [];
	const errors = [];
	for (let position = 0; position < mappingLines.length; position += 1) {
		const declaration = mappingLines[position];
		if (declaration.key !== 'env') continue;
		const value = declaration.rawValue.trim();
		if (value === '' || value.startsWith('#')) {
			let childIndent = null;
			for (let index = position + 1; index < mappingLines.length; index += 1) {
				const child = mappingLines[index];
				if (child.indent <= declaration.indent) break;
				childIndent ??= child.indent;
				if (child.indent !== childIndent) {
					errors.push({
						line: child.index,
						message: `nested mapping \`${child.line.trim()}\` under env: is outside this scanner's env model`,
					});
					continue;
				}
				entries.push({ name: child.key, value: envValueOf(child, blockTexts), line: child.index });
			}
			continue;
		}
		if (value === '{}') continue;
		const flow = value.match(/^\{(.*)\}$/s);
		if (flow) {
			for (const pair of splitFlowEntries(flow[1])) {
				const separator = pair.indexOf(':');
				if (separator < 0) {
					errors.push({
						line: declaration.index,
						message: `unreadable flow env entry \`${pair.trim()}\``,
					});
					continue;
				}
				entries.push({
					name: pair
						.slice(0, separator)
						.trim()
						.replace(/^['"]|['"]$/g, ''),
					value: pair.slice(separator + 1).trim(),
					line: declaration.index,
				});
			}
			continue;
		}
		errors.push({
			line: declaration.index,
			message: `env: value \`${value}\` is outside this scanner's model; declare env as a mapping`,
		});
	}
	return { entries, errors };
}

// Command substitutions, arithmetic expansion and process substitutions. All of
// them can reach the executor: `$((x))` evaluates array subscripts, and `<(cmd)`
// runs a command. Only spans that actually reference a tainted name are reported,
// so ordinary arithmetic in a workflow stays untouched.
// The interior of the parenthesised group whose `(` sits at `open`, and the index
// of its closing `)`. An unbalanced group runs to the end of the text, which is the
// reading that fails closed: everything after it is treated as inside it.
function balancedInterior(text, open) {
	let depth = 1;
	let cursor = open + 1;
	for (; cursor < text.length && depth; cursor += 1) {
		if (text[cursor] === '(') depth += 1;
		else if (text[cursor] === ')') depth -= 1;
	}
	return { text: text.slice(open + 1, depth ? text.length : cursor - 1), end: cursor - 1 };
}

function substitutionSpans(text) {
	const spans = [];
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character === '`' && !escapedByOddBackslashes(text, index)) {
			const end = text.indexOf('`', index + 1);
			spans.push({
				kind: 'a backtick command substitution',
				text: end < 0 ? text.slice(index + 1) : text.slice(index + 1, end),
			});
			if (end < 0) break;
			index = end;
			continue;
		}
		const opensSubstitution =
			(character === '$' && text[index + 1] === '(') ||
			((character === '<' || character === '>') && text[index + 1] === '(');
		if (!opensSubstitution) continue;
		const group = balancedInterior(text, index + 1);
		spans.push({
			kind: character === '$' ? 'a $(...) command substitution' : 'a <(...) process substitution',
			text: group.text,
		});
		index = group.end;
	}
	return spans;
}

function assignedName(token) {
	const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)\+?=/);
	return match ? match[1] : null;
}

/**
 * Grow the tainted set across shell assignments and same-line `$GITHUB_ENV`
 * writes until it stops growing. Renaming a value is not laundering it.
 */
function propagateTaint(runTexts, tainted) {
	let grew = true;
	while (grew) {
		grew = false;
		for (const { text } of runTexts) {
			for (const segment of runSegments(text)) {
				const rendered = segment.map((entry) => entry.value).join(' ');
				const carries = [...tainted].some((name) => referencesVariable(rendered, name));
				if (!carries) continue;
				const head = segment[0];
				const candidates = assignmentDeclarators.has(head?.quoted ? '' : head.value)
					? segment.slice(1)
					: segment;
				const writesGithubEnv = segment.some((entry) =>
					/^\$\{?GITHUB_(?:ENV|OUTPUT)\}?$/.test(entry.value)
				);
				for (const entry of candidates) {
					const name = assignedName(entry.value);
					if (name && !tainted.has(name)) {
						tainted.add(name);
						grew = true;
					}
				}
				if (!writesGithubEnv) continue;
				for (const entry of segment) {
					const name = assignedName(entry.value);
					if (name && !tainted.has(name)) {
						tainted.add(name);
						grew = true;
					}
				}
			}
		}
	}
	return tainted;
}

class ShellParseError extends Error {}

// Reserved words that hold a command position without being the command: what runs
// is the word after them. `time` is deliberately absent — it is a launcher wrapper
// here, so the finding still records that the sink was reached through one.
const commandPositionKeywords = new Set([
	'!',
	'{',
	'}',
	'do',
	'done',
	'elif',
	'else',
	'fi',
	'if',
	'then',
	'until',
	'while',
]);

// Redirection operators that can put an interpreter's program on its standard input.
const stdinRedirections = new Set(['<', '<<', '<<-', '<<<', '<>']);

// Longest-first, because `<<<` must win over `<<` and `<`.
const redirectionOperators = [
	'&>>',
	'&>',
	'<<<',
	'<<-',
	'<<',
	'<>',
	'<&',
	'>>',
	'>&',
	'>|',
	'<',
	'>',
];

// Options whose value the interpreter reads as program text rather than as data.
const programTextOptions = new Map([
	...[...shellInterpreters].map((name) => [name, /^--(?:rcfile|init-file)$/]),
	['node', /^(?:-r|--require|--import)$/],
	['nodejs', /^(?:-r|--require|--import)$/],
	['python', /^-m$/],
	['python3', /^-m$/],
]);

const assignmentWord = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/**
 * Lex one `run:` script into words, operators and redirections.
 *
 * Each word carries three readings of itself, because the rules need different ones:
 * `source` is the text with quote characters removed, which is what taint matching
 * reads; `literal` is the fully resolved value once quotes and backslashes are gone,
 * which is what command-word resolution reads and which only exists when `expanded`
 * is false; and `plain` is the unquoted, unescaped prefix, which is what decides
 * whether a word is an assignment — `"FOO=bar" cmd` runs a command called `FOO=bar`,
 * it does not assign.
 *
 * What this grammar covers: single and double quotes across line boundaries,
 * backslash escapes and line continuations, `$`/backtick expansions and `<(…)`
 * process substitutions, comments, fd-prefixed redirections including heredocs and
 * herestrings, and the operators `; ;; & && | || ( )`. What it does not cover it
 * refuses: `$'…'` and `$"…"` quoting, `|&`, `;&`, `;;&`, an unbalanced group, an
 * unterminated quote or heredoc, a redirection with no target. A refusal is a
 * finding, never a pass — that is the whole point of the inversion.
 */
function lexShellScript(text) {
	const tokens = [];
	const pendingHeredocs = [];
	let word = null;
	let pendingRedirect = null;
	let index = 0;

	const fail = (message) => {
		throw new ShellParseError(message);
	};
	const open = () => {
		word ??= { kind: 'word', source: '', literal: '', plain: '', expanded: false, quoted: false };
		return word;
	};
	const addLiteral = (characters, plain) => {
		const current = open();
		current.source += characters;
		current.literal += characters;
		if (plain && current.plain.length === current.literal.length - characters.length)
			current.plain += characters;
	};
	const endWord = () => {
		if (!word) return;
		if (!pendingRedirect) {
			tokens.push(word);
			word = null;
			return;
		}
		pendingRedirect.target = word;
		if (pendingRedirect.op === '<<' || pendingRedirect.op === '<<-') {
			if (word.expanded) fail('a heredoc delimiter built from an expansion is unmodelled');
			pendingRedirect.expands = !word.quoted;
			pendingHeredocs.push({
				delimiter: word.literal,
				stripTabs: pendingRedirect.op === '<<-',
				redirect: pendingRedirect,
			});
		}
		pendingRedirect = null;
		word = null;
	};
	const pushOperator = (value) => {
		endWord();
		if (pendingRedirect) fail(`redirection \`${pendingRedirect.op}\` has no target`);
		tokens.push({ kind: 'operator', value });
	};

	// The index of the `closer` that balances the `opener` at `start`. An unbalanced
	// group is refused rather than guessed past.
	const balanced = (start, opener, closer, label) => {
		let depth = 0;
		for (let cursor = start; cursor < text.length; cursor += 1) {
			if (text[cursor] === opener) depth += 1;
			else if (text[cursor] === closer && !(depth -= 1)) return cursor;
		}
		return fail(`unterminated ${label}`);
	};

	// One `$…` expansion beginning at `start`: its last index, and whether it is an
	// expansion at all. Outside double quotes `$'` and `$"` are ANSI-C and localized
	// quoting, whose escape semantics this scanner does not model; inside them the
	// same two characters are an ordinary `$`.
	const expansionAt = (start, inQuote) => {
		const next = text[start + 1];
		if (next === "'" || next === '"') {
			if (!inQuote) fail(`\`$${next}…\` quoting is outside this scanner's shell grammar`);
			return { end: start, expansion: false };
		}
		if (next === '(')
			return { end: balanced(start + 1, '(', ')', '`$(` substitution'), expansion: true };
		if (next === '{')
			return { end: balanced(start + 1, '{', '}', '`${` expansion'), expansion: true };
		if (/[A-Za-z_]/.test(next ?? '')) {
			let cursor = start + 1;
			while (/[A-Za-z0-9_]/.test(text[cursor] ?? '')) cursor += 1;
			return { end: cursor - 1, expansion: true };
		}
		if (/[0-9@*#?$!\-]/.test(next ?? '')) return { end: start + 1, expansion: true };
		// A `$` that expands nothing nameable. Marked as an expansion anyway: in a
		// command position this scanner would rather refuse than resolve a guess.
		return { end: start, expansion: true };
	};

	const readDoubleQuoted = (start) => {
		const current = open();
		current.quoted = true;
		for (let cursor = start + 1; cursor < text.length; cursor += 1) {
			const character = text[cursor];
			if (character === '"') return cursor + 1;
			if (character === '\\') {
				const next = text[cursor + 1];
				if (next === undefined) break;
				if (next === '\n') {
					cursor += 1;
					continue;
				}
				const escaped = '$`"\\'.includes(next) ? next : character + next;
				current.source += escaped;
				current.literal += escaped;
				cursor += 1;
				continue;
			}
			if (character === '`') {
				const close = text.indexOf('`', cursor + 1);
				if (close < 0) fail('unterminated backtick substitution');
				current.source += text.slice(cursor, close + 1);
				current.expanded = true;
				cursor = close;
				continue;
			}
			if (character === '$') {
				const { end, expansion } = expansionAt(cursor, true);
				current.source += text.slice(cursor, end + 1);
				if (expansion) current.expanded = true;
				else current.literal += text.slice(cursor, end + 1);
				cursor = end;
				continue;
			}
			current.source += character;
			current.literal += character;
		}
		return fail('unterminated double quote');
	};

	// Heredoc bodies begin on the line after the operator, so they are collected when
	// the newline is reached rather than where the `<<` was lexed.
	const drainHeredocs = (from) => {
		let cursor = from;
		while (pendingHeredocs.length) {
			const heredoc = pendingHeredocs.shift();
			const body = [];
			for (;;) {
				if (cursor >= text.length)
					fail(`heredoc delimited by \`${heredoc.delimiter}\` is unterminated`);
				const newline = text.indexOf('\n', cursor);
				const line = newline < 0 ? text.slice(cursor) : text.slice(cursor, newline);
				cursor = newline < 0 ? text.length : newline + 1;
				if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
				body.push(line);
			}
			heredoc.redirect.body = body.join('\n');
		}
		return cursor;
	};

	const readRedirection = (start) => {
		let fd = null;
		if (word && !word.expanded && !word.quoted && /^\d+$/.test(word.literal)) {
			fd = word.literal;
			word = null;
		}
		endWord();
		if (pendingRedirect) fail(`redirection \`${pendingRedirect.op}\` has no target`);
		const op = redirectionOperators.find((candidate) => text.startsWith(candidate, start));
		if (!op) return fail(`unmodelled redirection at \`${text.slice(start, start + 4)}\``);
		pendingRedirect = { kind: 'redirect', op, fd, target: null, body: null, expands: false };
		tokens.push(pendingRedirect);
		return start + op.length;
	};

	while (index < text.length) {
		const character = text[index];
		if (character === '\\') {
			const next = text[index + 1];
			if (next === undefined) fail('trailing backslash');
			if (next === '\n') {
				index += 2;
				continue;
			}
			open().quoted = true;
			addLiteral(next, false);
			index += 2;
			continue;
		}
		if (character === "'") {
			const close = text.indexOf("'", index + 1);
			if (close < 0) fail('unterminated single quote');
			const current = open();
			current.quoted = true;
			current.source += text.slice(index + 1, close);
			current.literal += text.slice(index + 1, close);
			index = close + 1;
			continue;
		}
		if (character === '"') {
			index = readDoubleQuoted(index);
			continue;
		}
		if (character === '`') {
			const close = text.indexOf('`', index + 1);
			if (close < 0) fail('unterminated backtick substitution');
			const current = open();
			current.source += text.slice(index, close + 1);
			current.expanded = true;
			index = close + 1;
			continue;
		}
		if (character === '$') {
			const { end, expansion } = expansionAt(index, false);
			const current = open();
			current.source += text.slice(index, end + 1);
			if (expansion) current.expanded = true;
			else current.literal += text.slice(index, end + 1);
			index = end + 1;
			continue;
		}
		// `<(…)` and `>(…)` are words, not redirections: the shell hands the command a
		// path to read. `< <(…)` is therefore a redirection *and* a substitution.
		if ((character === '<' || character === '>') && text[index + 1] === '(') {
			const close = balanced(index + 1, '(', ')', 'process substitution');
			const current = open();
			current.source += text.slice(index, close + 1);
			current.expanded = true;
			index = close + 1;
			continue;
		}
		if (character === '#' && !word) {
			const newline = text.indexOf('\n', index);
			index = newline < 0 ? text.length : newline;
			continue;
		}
		if (character === '\n') {
			pushOperator('\n');
			index = drainHeredocs(index + 1);
			continue;
		}
		if (character === ' ' || character === '\t' || character === '\r') {
			endWord();
			index += 1;
			continue;
		}
		if (character === '<' || character === '>') {
			index = readRedirection(index);
			continue;
		}
		if (character === '&') {
			if (text[index + 1] === '>') {
				index = readRedirection(index);
				continue;
			}
			const double = text[index + 1] === '&';
			pushOperator(double ? '&&' : '&');
			index += double ? 2 : 1;
			continue;
		}
		if (character === '|') {
			if (text[index + 1] === '&') fail("`|&` is outside this scanner's shell grammar");
			const double = text[index + 1] === '|';
			pushOperator(double ? '||' : '|');
			index += double ? 2 : 1;
			continue;
		}
		if (character === ';') {
			if (text[index + 1] === '&') fail("`;&` is outside this scanner's shell grammar");
			if (text[index + 1] === ';' && text[index + 2] === '&')
				fail("`;;&` is outside this scanner's shell grammar");
			const double = text[index + 1] === ';';
			pushOperator(double ? ';;' : ';');
			index += double ? 2 : 1;
			continue;
		}
		if (character === '(' || character === ')') {
			pushOperator(character);
			index += 1;
			continue;
		}
		addLiteral(character, true);
		index += 1;
	}
	endWord();
	if (pendingRedirect) fail(`redirection \`${pendingRedirect.op}\` has no target`);
	if (pendingHeredocs.length)
		fail(`heredoc delimited by \`${pendingHeredocs[0].delimiter}\` is unterminated`);
	return tokens;
}

/**
 * Reduce a lexed script to the simple commands it runs, each with its assignment
 * prefixes, its words and its redirections. Command positions are the ones the shell
 * gives them: the start of the script, after `; & && || | ( )` and newlines, after
 * `!`, after a grouping token, and inside the `if`/`while`/`until`/`for`/`case`
 * compounds. `for` headers and `case` pattern lists are word lists, not commands, and
 * are skipped as such — which is why `for` and `case` in a real workflow do not
 * become findings. Anything this walk cannot place is refused.
 */
function parseSimpleCommands(tokens) {
	const commands = [];
	let current = null;
	let mode = 'command';
	let groupDepth = 0;
	let caseDepth = 0;

	const fail = (message) => {
		throw new ShellParseError(message);
	};
	const flush = () => {
		if (current) commands.push(current);
		current = null;
	};
	const command = () => (current ??= { assignments: [], words: [], redirects: [] });

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind === 'redirect') {
			if (mode !== 'command' && mode !== 'arguments')
				fail('a redirection inside a `for` header or `case` pattern is unmodelled');
			command().redirects.push(token);
			continue;
		}
		if (token.kind === 'operator') {
			if (mode === 'casePattern') {
				if (token.value === ')') mode = 'command';
				else if (!['(', '|', '\n'].includes(token.value))
					fail(`\`${token.value}\` in a \`case\` pattern list is unmodelled`);
				continue;
			}
			switch (token.value) {
				case ';':
				case '&':
				case '\n':
				case '&&':
				case '||':
				case '|':
					flush();
					mode = 'command';
					break;
				case ';;':
					if (!caseDepth) fail('`;;` outside a `case`');
					flush();
					mode = 'casePattern';
					break;
				case '(':
					flush();
					groupDepth += 1;
					mode = 'command';
					break;
				case ')':
					flush();
					groupDepth -= 1;
					if (groupDepth < 0) fail('unbalanced `)`');
					mode = 'command';
					break;
				default:
					fail(`unmodelled operator \`${token.value}\``);
			}
			continue;
		}
		const resolvable = !token.expanded && !token.quoted;
		if (mode === 'caseSubject') {
			mode = 'caseIn';
			continue;
		}
		if (mode === 'caseIn') {
			if (resolvable && token.literal === 'in') mode = 'casePattern';
			else fail('a `case` head without `in` is unmodelled');
			continue;
		}
		if (mode === 'casePattern') {
			if (resolvable && token.literal === 'esac') {
				caseDepth -= 1;
				mode = 'command';
			}
			continue;
		}
		if (mode === 'forHeader') {
			if (resolvable && token.literal === 'do') mode = 'command';
			continue;
		}
		if (mode === 'command' && resolvable) {
			const literal = token.literal;
			if (literal === 'case') {
				caseDepth += 1;
				mode = 'caseSubject';
				continue;
			}
			if (literal === 'esac') {
				if (!caseDepth) fail('`esac` outside a `case`');
				caseDepth -= 1;
				continue;
			}
			if (literal === 'for' || literal === 'select') {
				mode = 'forHeader';
				continue;
			}
			if (literal === 'in') fail('`in` outside a `for` or `case` head');
			if (commandPositionKeywords.has(literal)) continue;
			// `name () { … }` — the name is not executed here, the body's commands are.
			if (
				tokens[index + 1]?.value === '(' &&
				tokens[index + 2]?.value === ')' &&
				tokens[index + 1].kind === 'operator'
			) {
				index += 2;
				continue;
			}
		}
		// An assignment prefix is named by its unquoted, unescaped prefix and nothing
		// else. `RESULT="$(…)"` assigns; `"RESULT=x"` runs a command called `RESULT=x`.
		if (mode === 'command' && assignmentWord.test(token.plain)) {
			command().assignments.push(token);
			continue;
		}
		command().words.push(token);
		mode = 'arguments';
	}
	flush();
	if (groupDepth) fail('unbalanced `(`');
	if (caseDepth) fail('unterminated `case`');
	return commands;
}

/**
 * What a parsed command executes. Judging the first word alone lets `env bash -c
 * "$VALUE"` past a rule that stops the bare `bash -c` it contains, so resolution
 * steps over each launcher wrapper and over the assignments and options that belong
 * to it, chained as deeply as the command nests them.
 *
 * The command word must then resolve to a *literal*. `$UNSET bash -c "$VALUE"` and
 * `VAR=bash; $VAR -c "$VALUE"` execute an interpreter while naming no word this
 * scanner can read, so they are returned as unresolved and reported — no literal
 * tracking, no enumeration of what a variable might hold.
 *
 * Wrapper option grammars differ, and one whose option takes a separate value
 * (`env -u NAME bash -c …`) would otherwise resolve to that value. So once a wrapper
 * has been consumed — or once the command word has failed to resolve — every later
 * literal interpreter word is an additional head. Those extra heads carry the
 * interpreter rules only, so `env printf '%s' "$VALUE"` stays the data use it is.
 */
function resolveExecution(words) {
	const isLiteral = (entry) => !entry.expanded;
	let index = 0;
	let wrapped = false;
	while (
		index < words.length &&
		isLiteral(words[index]) &&
		launcherWrappers.has(words[index].literal)
	) {
		wrapped = true;
		index += 1;
		// The wrapper's own assignments and options. An assignment is recognised by its
		// unquoted prefix, so `env COPY="$VALUE" ./pinned.sh` still resolves to the
		// script — the value is being placed in an environment, not executed.
		while (
			index < words.length &&
			(assignmentWord.test(words[index].plain) ||
				(isLiteral(words[index]) && /^[-+]/.test(words[index].literal)))
		)
			index += 1;
	}
	const trailingInterpreters = (from) => {
		const heads = [];
		for (let cursor = from; cursor < words.length; cursor += 1)
			if (isLiteral(words[cursor]) && interpreterWords.has(words[cursor].literal))
				heads.push(cursor);
		return heads;
	};
	if (index >= words.length) return { heads: [], wrapped, unresolved: null };
	if (!isLiteral(words[index]))
		return { heads: trailingInterpreters(index + 1), wrapped, unresolved: words[index] };
	return {
		heads: [index, ...(wrapped ? trailingInterpreters(index + 1) : [])],
		wrapped,
		unresolved: null,
	};
}

// The text a redirection carries. A heredoc whose delimiter was quoted does not
// expand, so its body is not a path a value can travel down.
function redirectText(redirect) {
	if (redirect.op === '<<' || redirect.op === '<<-')
		return redirect.expands ? (redirect.body ?? '') : '';
	return redirect.target?.source ?? '';
}

/**
 * Program text an interpreter reads from standard input: a herestring, a heredoc
 * that expands, a process substitution redirected onto stdin, or an ordinary `<`
 * whose operand the interpreter then runs. The interpreter executes what it reads,
 * and none of these carries the `-c` flag the inline-script rule looks for.
 *
 * A literal script operand suppresses the rule: stdin then belongs to that script,
 * and a value reaching a sink inside a called script is a recorded residual rather
 * than a shape this scanner judges. An operand that names standard input itself
 * suppresses nothing, because it takes nothing away, and an operand that is an
 * expansion suppresses nothing either — an unreadable operand is not a proof.
 */
function stdinProgramSpans(rest, redirects) {
	for (const entry of rest) {
		if (entry.expanded) continue;
		if (standardInputNames.has(entry.literal)) continue;
		if (/^[-+]/.test(entry.literal) || assignmentWord.test(entry.plain)) continue;
		if (scriptOperand.test(entry.literal)) return [];
	}
	const spans = [];
	for (const redirect of redirects) {
		if (!stdinRedirections.has(redirect.op) || (redirect.fd ?? '0') !== '0') continue;
		const text = redirectText(redirect);
		if (redirect.op === '<<<') spans.push({ kind: 'a `<<<` herestring', text });
		else if (redirect.op === '<<' || redirect.op === '<<-') spans.push({ kind: 'a heredoc', text });
		else if (/^<\(/.test(redirect.target?.source ?? ''))
			spans.push({
				kind: 'a `< <(...)` stdin process substitution',
				text: balancedInterior(redirect.target.source, 1).text,
			});
		else spans.push({ kind: `a \`${redirect.op}\` stdin redirection`, text });
	}
	return spans;
}

// An option whose value the interpreter reads as program text: `bash --rcfile FILE`
// sources FILE before anything else, and `node -r MODULE` runs MODULE.
function programOptionSpans(headWord, rest) {
	const option = programTextOptions.get(headWord);
	if (!option) return [];
	const spans = [];
	for (let index = 0; index < rest.length; index += 1) {
		const entry = rest[index];
		if (entry.expanded) continue;
		const separator = entry.literal.indexOf('=');
		if (separator > 0 && option.test(entry.literal.slice(0, separator))) {
			spans.push({
				kind: `\`${headWord} ${entry.literal.slice(0, separator)}\``,
				text: entry.source.slice(entry.source.indexOf('=') + 1),
			});
			continue;
		}
		if (option.test(entry.literal) && rest[index + 1])
			spans.push({ kind: `\`${headWord} ${entry.literal}\``, text: rest[index + 1].source });
	}
	return spans;
}

/**
 * An inline `run:` value is a YAML scalar before it is shell, and the two layers do
 * not compose safely. `run: 'bash -c "$VALUE"'` is one YAML string whose *contents*
 * are the script; handed to a shell lexer with the YAML quoting still on, it reads
 * as a single enormous quoted word and every sink rule misses it. An alias
 * (`run: *script`) is not even present in the text.
 *
 * The lesson of this whole thread is that a scanner which unpicks a second notation
 * in passing loses to that notation's grammar, so this one does not try. Two forms
 * are read: a plain scalar, which is already shell, and a block scalar, whose body
 * `scanWorkflowLines` has already collected. Every other inline form — quoted,
 * aliased, anchored, tagged — is refused in a file that carries tainted data. The
 * repair is one character: make it a `run: |` block.
 */
const opaqueRunScalar = {
	"'": 'a single-quoted',
	'"': 'a double-quoted',
	'*': 'an aliased',
	'&': 'an anchored',
	'!': 'a tagged',
};

function yamlRunScalar(value) {
	const opaque = opaqueRunScalar[value.trimStart()[0]];
	return opaque
		? {
				error:
					`${opaque} inline run: scalar, which is a YAML value this scanner does not ` +
					'decode into shell text — write it as a `run: |` block',
			}
		: { text: value };
}

function executableSinkFindings(text, tainted) {
	const findings = [];
	const names = [...tainted];
	const hits = (token) => names.filter((name) => referencesVariable(token, name));
	const report = (matched, sink) => {
		if (matched.length) findings.push({ kind: 'sink', names: matched, sink });
	};

	let commands;
	try {
		commands = parseSimpleCommands(lexShellScript(text));
	} catch (error) {
		if (!(error instanceof ShellParseError)) throw error;
		return [{ kind: 'unproven', reason: error.message }];
	}

	for (const { words, redirects } of commands) {
		if (!words.length) continue;
		const { heads, wrapped, unresolved } = resolveExecution(words);
		const via = wrapped ? ' reached through a launcher wrapper' : '';
		if (unresolved) {
			// A variable that resolves to the command word is execution, not data —
			// and a command word this scanner cannot resolve is not proven to be data
			// either, which is the same finding for a different reason.
			const matched = hits(unresolved.source);
			if (matched.length)
				findings.push({
					kind: 'sink',
					names: matched,
					sink: `the command word of a shell segment${via}`,
				});
			else
				findings.push({
					kind: 'unproven',
					reason:
						`the command word \`${unresolved.source}\`${via} is an expansion, so what this ` +
						'segment executes cannot be resolved to a literal',
				});
		}
		for (const position of heads) {
			const headWord = words[position].literal;
			const rest = words.slice(position + 1);
			// A redirection belongs to the same command as its words, so a value that
			// arrives through one is judged with the rest of that command's text.
			const attached = [...rest.map((entry) => entry.source), ...redirects.map(redirectText)];
			// Whether the interpreter already holds its program inline. If it does,
			// its standard input is that program's data rather than a second program.
			let inlineProgram = false;
			if (shellInterpreters.has(headWord)) {
				const flag = rest.find(
					(entry) => !entry.expanded && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(entry.literal)
				);
				if (flag) {
					inlineProgram = true;
					for (const value of attached)
						report(hits(value), `\`${headWord} ${flag.literal}\`${via}`);
				}
			}
			if (headWord === 'eval') for (const value of attached) report(hits(value), `\`eval\`${via}`);
			// `source`/`.` take a program, not an argument, so every operand is program
			// text: `source <(printf '%s' "$VALUE")` executes what the substitution
			// prints, though that same substitution standing alone only prints it.
			if (sourceCommands.has(headWord))
				for (const value of attached) report(hits(value), `\`${headWord}\`${via}`);
			const inline = inlineScriptFlags.get(headWord);
			if (inline) {
				const flag = rest.find((entry) => !entry.expanded && inline.test(entry.literal));
				if (flag) {
					inlineProgram = true;
					for (const value of attached)
						report(hits(value), `\`${headWord} ${flag.literal}\`${via}`);
				}
			}
			for (const span of programOptionSpans(headWord, rest))
				report(hits(span.text), `${span.kind}${via}`);
			if (!inlineProgram && stdinInterpreters.has(headWord))
				for (const span of stdinProgramSpans(rest, redirects))
					report(hits(span.text), `${span.kind} run by \`${headWord}\`${via}`);
		}
	}
	// A substitution is a nested shell, so it is judged by the same rules rather
	// than by the mere presence of the name: `$(printf '%s' "$TITLE")` consumes the
	// value as data exactly as `printf '%s' "$TITLE"` does, while `$($TITLE)` and
	// `$(bash -c "$TITLE")` reach an executor and are reported as such.
	for (const span of substitutionSpans(text)) {
		if (!names.some((name) => referencesVariable(span.text, name))) continue;
		for (const finding of executableSinkFindings(span.text, tainted))
			findings.push(
				finding.kind === 'sink'
					? { ...finding, sink: `${finding.sink} inside ${span.kind}` }
					: { ...finding, reason: `${finding.reason}, inside ${span.kind}` }
			);
	}
	return findings;
}

/**
 * The composite `env:` prohibition and the executable-sink rule, over the workflow
 * set and every local composite action manifest it reaches.
 */
export function validateEventEnvSinks(directory = workflowDirectory, root = '.') {
	const findings = [];
	const targets = [
		...yamlFiles(directory).map((file) => ({ file, composite: false })),
		...localActionManifests(directory, root).map((file) => ({ file, composite: true })),
	];
	for (const { file, composite } of targets) {
		const { mappingLines, runTexts, blockTexts } = scanWorkflowLines(readFileSync(file, 'utf8'));
		const { entries, errors } = envDeclarations(mappingLines, blockTexts);
		for (const error of errors) findings.push(`${file}:${error.line + 1}: ${error.message}`);
		// A composite may not splice a caller-supplied input straight into `run:`
		// either: the `with:` channel is allowed because the value arrives as data,
		// and interpolation makes it program text.
		if (composite)
			for (const { line, text } of runTexts)
				for (const expression of inputExpressionsIn(text))
					findings.push(
						`${file}:${line + 1}: composite run: interpolates ${expression} directly; ` +
							'a caller may pass event payload as that input — carry it through env: and ' +
							'reference the shell variable instead'
					);
		const tainted = new Set();
		for (const entry of entries) {
			const expressions = eventExpressionsIn(entry.value);
			if (composite && expressions.length) {
				findings.push(
					`${file}:${entry.line + 1}: composite action env: ${entry.name} carries ` +
						`${expressions[0]}; a composite receives event-derived data through with: inputs, ` +
						'never by re-crossing the trust boundary inside the action'
				);
				continue;
			}
			// Inside a composite an input is caller-supplied and may be event payload,
			// so it is tainted for the sink rule even though carrying it is allowed.
			const carried = expressions.length
				? expressions
				: composite
					? inputExpressionsIn(entry.value)
					: [];
			if (!carried.length) continue;
			if (!shellIdentifier.test(entry.name)) {
				findings.push(
					`${file}:${entry.line + 1}: env: name \`${entry.name}\` carries ${carried[0]} and ` +
						'is not a shell identifier, so its use cannot be bounded by this scanner'
				);
				continue;
			}
			tainted.add(entry.name);
		}
		if (!tainted.size) continue;
		propagateTaint(runTexts, tainted);
		const origin = composite ? 'caller-supplied' : 'event-derived';
		for (const { line, text, inlineScalar } of runTexts) {
			const scalar = inlineScalar ? yamlRunScalar(text) : { text };
			if (scalar.error) {
				findings.push(
					`${file}:${line + 1}: run: cannot be proven free of an executable sink: ` +
						`${scalar.error}. This file carries ${origin} data in env:, so a run: value ` +
						'this scanner cannot read as shell is a finding, not a pass'
				);
				continue;
			}
			for (const finding of executableSinkFindings(scalar.text, tainted))
				findings.push(
					finding.kind === 'sink'
						? `${file}:${line + 1}: run: reaches ${finding.sink} with ${origin} ` +
								`${finding.names.map((name) => `$${name}`).join(', ')}; ` +
								'pass the value as data (an argument to a non-executing command, or argv to a ' +
								'pinned script) instead of as program text'
						: `${file}:${line + 1}: run: cannot be proven free of an executable sink: ` +
								`${finding.reason}. This file carries ${origin} data in env:, so a segment ` +
								'this scanner cannot resolve is a finding, not a pass'
				);
		}
	}
	return findings;
}

const packageManagers = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const installVerbs = new Set(['install', 'i', 'ci', 'add', 'import']);

/**
 * Split one `run:` script into shell segments, tracking whether each token was
 * quoted. Only unquoted tokens can name a command, so `echo "pnpm install"` is
 * text rather than an install. Continuations are joined; comments are stripped.
 */
function runSegments(text) {
	const logical = [];
	let pending = '';
	for (const physical of text.split('\n')) {
		const { command } = stripRunBlockComment(physical);
		const line = `${pending}${command}`;
		if (
			/\\$/.test(line.trimEnd()) &&
			escapedByOddBackslashes(line.trimEnd(), line.trimEnd().length)
		) {
			pending = `${line.trimEnd().slice(0, -1)} `;
			continue;
		}
		pending = '';
		if (line.trim()) logical.push(line);
	}
	if (pending.trim()) logical.push(pending);

	const segments = [];
	for (const line of logical) {
		let current = [];
		let token = '';
		let quoted = false;
		let started = false;
		let quote = null;
		const endToken = () => {
			if (started || token) current.push({ value: token, quoted });
			token = '';
			quoted = false;
			started = false;
		};
		const endSegment = () => {
			endToken();
			if (current.length) segments.push(current);
			current = [];
		};
		for (let index = 0; index < line.length; index += 1) {
			const char = line[index];
			if (quote) {
				if (char === quote) quote = null;
				else token += char;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				quoted = true;
				started = true;
				continue;
			}
			const pair = line.slice(index, index + 2);
			if (pair === '&&' || pair === '||') {
				endSegment();
				index += 1;
				continue;
			}
			if (char === ';' || char === '|' || char === '&') {
				endSegment();
				continue;
			}
			if (/\s/.test(char)) {
				endToken();
				continue;
			}
			token += char;
			started = true;
		}
		endSegment();
	}
	return segments;
}

/**
 * Every package-manager install in every workflow and every local composite action
 * must be one of the exact invocations pinned in the repo contract. `--ignore-scripts`
 * is the boundary the whole supply-chain claim rests on, and the installs that run
 * before the rubric are the ones the rubric cannot police from inside.
 */
export function validateInstallInvocations(
	directory = workflowDirectory,
	allowed = [],
	root = '.'
) {
	const findings = [];
	const permitted = new Set(allowed);
	for (const file of [...yamlFiles(directory), ...localActionManifests(directory, root)]) {
		const { runTexts } = scanWorkflowLines(readFileSync(file, 'utf8'));
		for (const { line, text } of runTexts) {
			for (const segment of runSegments(text)) {
				const isInstall = segment.some(
					(entry, index) =>
						!entry.quoted &&
						packageManagers.has(entry.value) &&
						!segment[index + 1]?.quoted &&
						installVerbs.has(segment[index + 1]?.value ?? '')
				);
				if (!isInstall) continue;
				const rendered = segment
					.map((entry) => entry.value)
					.join(' ')
					.trim();
				if (permitted.has(rendered)) continue;
				findings.push(
					`${file}:${line + 1}: install invocation \`${rendered}\` is not a pinned invocation; ` +
						`allowed: ${[...permitted].map((entry) => `\`${entry}\``).join(', ') || 'none'}`
				);
			}
		}
	}
	return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [mode, directory] = process.argv.slice(2);
	const contractPath = 'gov-infra/planning/contentus-pinned-repo-contract.json';
	const policy = () => {
		let workflows;
		try {
			workflows = readStrictJson(contractPath).workflows;
		} catch (error) {
			return [`${contractPath} is missing or unparseable: ${error.message}`];
		}
		const allowedWrites = workflows?.allowed_write_permissions;
		const allowedInstalls = workflows?.allowed_install_invocations;
		if (!Array.isArray(allowedWrites))
			return [`${contractPath}: workflows.allowed_write_permissions must be an array`];
		if (!Array.isArray(allowedInstalls) || allowedInstalls.length === 0)
			return [
				`${contractPath}: workflows.allowed_install_invocations must be a non-empty array; ` +
					'an empty allowlist would let any install shape pass',
			];
		return [
			...validateWorkflowPermissions(directory, allowedWrites),
			...validateRunExpressions(directory),
			...validateEventEnvSinks(directory),
			...validateInstallInvocations(directory, allowedInstalls),
		];
	};
	const findings =
		mode === '--uses'
			? validateActionPins(directory)
			: mode === '--triggers'
				? validatePullRequestTriggers(directory)
				: mode === '--policy'
					? policy()
					: null;
	if (!findings || process.argv.length > 4) {
		console.error('Usage: validate-workflows.mjs --uses|--triggers|--policy [workflow-directory]');
		process.exitCode = 2;
	} else if (findings.length) {
		console.error(findings.join('\n'));
		process.exitCode = 1;
	}
}
