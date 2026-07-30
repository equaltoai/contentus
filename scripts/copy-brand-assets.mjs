#!/usr/bin/env node

/**
 * Copy the Theory Cloud brand assets into the client build verbatim.
 *
 * They land under `build/client/brand/`, which `lesser client install`
 * publishes to `/l/_assets/brand/`. Copied byte-for-byte: the icons, wordmark,
 * and OG card are design-pack artifacts, and re-encoding or optimizing them
 * here would fork the brand.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = join(repoRoot, 'assets');
const targetDir = join(repoRoot, 'build/client/brand');

function countFiles(dir) {
	let total = 0;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		total += statSync(full).isDirectory() ? countFiles(full) : 1;
	}
	return total;
}

function main() {
	if (!existsSync(sourceDir)) {
		console.error(`brand assets: ${sourceDir} is missing; nothing to publish.`);
		process.exitCode = 1;
		return;
	}

	mkdirSync(targetDir, { recursive: true });
	cpSync(sourceDir, targetDir, { recursive: true });
	console.log(`brand assets: copied ${countFiles(sourceDir)} files to build/client/brand/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
