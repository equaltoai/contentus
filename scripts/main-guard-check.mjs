#!/usr/bin/env node
/**
 * Promotion-only `main`: a pull request into `main` must come from this
 * repository's own `staging` branch.
 *
 * This logic used to be three `test` commands inline in
 * `.github/workflows/main-guard.yml`. `HEAD_REPOSITORY` is derived from
 * `github.event`, and under the workflow scanner's appearance rule an
 * event-derived value may appear in a `run:` script only as argv to a script
 * pinned by content in `contentus-pinned-repo-contract.json`, or as an argument to
 * printf-style data emission — `test` is neither. So the workflow now passes all
 * four values as argv and this file is pinned by SHA-256, which binds the
 * comparison's content rather than the text that names it.
 *
 * The comparisons and their order are the inline version's: `set -e` stopped at
 * the first failing `test`, so this exits at the first mismatch with the same
 * status 1. A missing argument compares as the empty string, exactly as an unset
 * `env:` value did.
 */
const [baseRef = '', headRef = '', headRepository = '', currentRepository = ''] =
	process.argv.slice(2);

const refuse = (message) => {
	console.error(message);
	process.exit(1);
};

if (baseRef !== 'main') refuse(`base ref must be main, got ${JSON.stringify(baseRef)}`);
if (headRef !== 'staging') refuse(`head ref must be staging, got ${JSON.stringify(headRef)}`);
if (headRepository !== currentRepository)
	refuse(
		`head repository must be ${JSON.stringify(currentRepository)}, got ${JSON.stringify(headRepository)}`
	);
