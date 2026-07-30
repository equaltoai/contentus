#!/usr/bin/env node

/**
 * CSP audit.
 *
 * Adapted from emdash's `scripts/audit-csp.mjs`, which in turn derives from
 * greater-components' scanner. Contentus differs in what it audits: emdash
 * scans a static SSG artifact, while contentus renders per request, so this
 * drives the built handler and scans the HTML it actually emits (see
 * `render-routes.mjs`).
 *
 * Ship-blocking findings:
 *   - inline `<script>` with a body
 *   - inline `<style>` with a body
 *   - `style="…"` attributes
 *   - `on*="…"` event-handler attributes
 *   - malformed start tags (ambiguous parses are bypass-prone)
 *   - any off-origin script or stylesheet reference
 *   - a missing or non-strict `content-security-policy` response header
 *
 * There is no baseline file. Contentus starts clean, and a baseline exists to
 * carry pre-existing debt that does not apply here — adding one later should
 * take a deliberate argument, not a default.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAllRoutes } from './render-routes.mjs';

function lineFor(content, index) {
	return content.slice(0, Math.max(0, index)).split('\n').length;
}

function snippet(value) {
	const compact = value.replace(/\s+/g, ' ').trim();
	return compact.slice(0, 100) + (compact.length > 100 ? '…' : '');
}

/**
 * Tokenize a start tag's real attributes rather than regexing its raw text: a
 * quoted attribute value may legitimately contain the string `onclick=`.
 */
function attributesFor(tagMarkup) {
	const start = tagMarkup.match(/^<[A-Za-z][^\s/>]*/)?.[0].length ?? 1;
	const attributes = [];
	let cursor = start;
	const end = tagMarkup.length - 1;

	while (cursor < end) {
		while (cursor < end && /[\s/]/.test(tagMarkup[cursor])) cursor += 1;
		if (cursor >= end) break;

		const attributeStart = cursor;
		while (cursor < end && !/[\s=/>]/.test(tagMarkup[cursor])) cursor += 1;
		const name = tagMarkup.slice(attributeStart, cursor);
		if (!name) {
			cursor += 1;
			continue;
		}

		while (cursor < end && /\s/.test(tagMarkup[cursor])) cursor += 1;
		let value = '';
		let quoted = false;
		if (tagMarkup[cursor] === '=') {
			cursor += 1;
			while (cursor < end && /\s/.test(tagMarkup[cursor])) cursor += 1;
			if (tagMarkup[cursor] === '"' || tagMarkup[cursor] === "'") {
				const quote = tagMarkup[cursor++];
				quoted = true;
				const valueStart = cursor;
				while (cursor < end && tagMarkup[cursor] !== quote) cursor += 1;
				value = tagMarkup.slice(valueStart, cursor);
				if (cursor < end) cursor += 1;
			} else {
				const valueStart = cursor;
				// HTML permits `/` in unquoted values (notably absolute URLs).
				while (cursor < end && !/[\s>]/.test(tagMarkup[cursor])) cursor += 1;
				value = tagMarkup.slice(valueStart, cursor);
			}
		}

		const raw = tagMarkup.slice(attributeStart, cursor);
		attributes.push({ name: name.toLowerCase(), value, raw, index: attributeStart, quoted });

		// Browser recovery of slash-separated event/style attributes applies only
		// to unquoted values; quoted URL paths are data, not attributes.
		if (quoted) continue;
		for (const match of value.matchAll(/\/(on[a-z]+|style)\s*=/gi)) {
			attributes.push({
				name: match[1].toLowerCase(),
				value: '',
				raw: match[0].slice(1),
				index: attributeStart + raw.indexOf(match[0]) + 1,
			});
		}
	}
	return attributes;
}

function* startTags(content, wanted = null) {
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] !== '<' || !/[A-Za-z]/.test(content[index + 1] ?? '')) continue;

		let cursor = index + 1;
		while (/[A-Za-z0-9:-]/.test(content[cursor] ?? '')) cursor += 1;
		const name = content.slice(index + 1, cursor).toLowerCase();

		let quote = null;
		let recoveryIndex = null;
		for (; cursor < content.length; cursor += 1) {
			const char = content[cursor];
			if (quote) {
				if (char === quote) quote = null;
				// `<` is legal data inside a properly closed quoted attribute.
				// Retain its first position only as a recovery point if the quote
				// runs to EOF.
				else if (char === '<' && recoveryIndex === null) recoveryIndex = cursor;
			} else if (char === '"' || char === "'") quote = char;
			else if (char === '>') break;
		}

		if (quote || cursor >= content.length) {
			yield { index, name, markup: content.slice(index, cursor), malformed: true };
			if (recoveryIndex !== null) {
				index = recoveryIndex - 1;
				continue;
			}
			return;
		}

		if (!wanted || wanted.has(name)) {
			yield { index, name, markup: content.slice(index, cursor + 1) };
		}
		index = cursor;
	}
}

function externalOrigin(value) {
	try {
		const placeholder = 'https://placeholder.invalid/';
		const parsed = new URL(value, placeholder);
		if (parsed.origin === new URL(placeholder).origin) return 'same-origin';
		if (parsed.origin === 'null') {
			return parsed.protocol === 'data:' ? 'data:' : `opaque:${parsed.protocol}`;
		}
		return parsed.origin;
	} catch {
		return 'same-origin';
	}
}

function scanDocument(route) {
	const content = route.html;
	const findings = [];
	const add = (index, type, value) =>
		findings.push({
			route: route.name,
			path: route.path,
			line: lineFor(content, index),
			type,
			snippet: snippet(value),
		});

	for (const tag of startTags(content)) {
		if (tag.malformed) {
			add(tag.index, 'malformed-start-tag', tag.markup);
			continue;
		}
		for (const attribute of attributesFor(tag.markup)) {
			if (attribute.name === 'style') {
				add(tag.index + attribute.index, 'inline-style-attribute', attribute.raw);
			}
			if (/^on[a-z]+$/i.test(attribute.name)) {
				add(tag.index + attribute.index, 'inline-event-handler', attribute.raw);
			}
		}
	}

	for (const match of content.matchAll(
		/<style\b[^>]*>([\s\S]*?)(?:<\/style(?=[\s/>])[^>]*>|$)/gi
	)) {
		if ((match[1] ?? '').trim()) add(match.index ?? 0, 'inline-style-tag', match[0]);
	}

	for (const match of content.matchAll(
		/<script\b([^>]*)>([\s\S]*?)(?:<\/script(?=[\s/>])[^>]*>|$)/gi
	)) {
		// HTML ignores a script body when `src` is present, but non-empty markup
		// is still forbidden: it is ambiguous and bypass-prone under strict CSP.
		if ((match[2] ?? '').trim()) add(match.index ?? 0, 'inline-script', match[0]);
	}

	return findings;
}

function scanOrigins(route) {
	const origins = new Set();
	for (const tag of startTags(route.html, new Set(['script', 'link']))) {
		if (tag.malformed) continue;
		const attrs = attributesFor(tag.markup);
		const source = attrs.find((a) => a.name === (tag.name === 'script' ? 'src' : 'href'));
		const rel = new Set(
			(attrs.find((a) => a.name === 'rel')?.value ?? '').toLowerCase().split(/\s+/)
		);
		const as = attrs.find((a) => a.name === 'as')?.value?.toLowerCase();
		const scriptLink = rel.has('modulepreload') || (rel.has('preload') && as === 'script');
		if (!source || (tag.name === 'link' && !rel.has('stylesheet') && !scriptLink)) continue;
		origins.add(externalOrigin(source.value));
	}
	return [...origins];
}

/** The directives a strict policy must carry. */
function scanCspHeader(route) {
	const header = route.headers['content-security-policy'];
	if (!header) {
		return [
			{ route: route.name, path: route.path, line: 0, type: 'missing-csp-header', snippet: '' },
		];
	}

	const problems = [];
	const flag = (type, detail) =>
		problems.push({ route: route.name, path: route.path, line: 0, type, snippet: detail });

	if (/unsafe-inline/i.test(header)) flag('csp-allows-unsafe-inline', header);
	if (/unsafe-eval/i.test(header)) flag('csp-allows-unsafe-eval', header);
	if (!/(^|;)\s*default-src/i.test(header)) flag('csp-missing-default-src', header);
	if (!/(^|;)\s*object-src\s+'none'/i.test(header)) flag('csp-missing-object-src-none', header);
	if (!/(^|;)\s*base-uri/i.test(header)) flag('csp-missing-base-uri', header);
	if (!/(^|;)\s*frame-ancestors/i.test(header)) flag('csp-missing-frame-ancestors', header);

	return problems;
}

async function main() {
	const rendered = await renderAllRoutes();

	const findings = [];
	const originsByRoute = new Map();
	const statusProblems = [];

	for (const route of rendered) {
		if (route.status !== route.expectStatus) {
			statusProblems.push(`${route.path} returned ${route.status}, expected ${route.expectStatus}`);
		}
		// The hydration endpoint is JSON, not a document; only its header is
		// meaningful to this audit.
		if (route.name !== 'hydration-data') {
			findings.push(...scanDocument(route));
			originsByRoute.set(route.name, scanOrigins(route));
		}
		findings.push(...scanCspHeader(route));
	}

	const offOrigin = [];
	for (const [name, origins] of originsByRoute) {
		for (const origin of origins) {
			if (origin !== 'same-origin') offOrigin.push(`${name}: ${origin}`);
		}
	}

	console.log('# CSP Audit — contentus SSR output\n');
	console.log(`- Routes rendered from build/server/handler.mjs: ${rendered.length}`);
	console.log(`- Documents scanned: ${originsByRoute.size}`);
	console.log(`- Ship-blocking findings: ${findings.length}`);
	console.log(`- Off-origin script/style references: ${offOrigin.length}`);
	console.log(`- Route status mismatches: ${statusProblems.length}\n`);

	console.log('## Per-route');
	for (const route of rendered) {
		const routeFindings = findings.filter((f) => f.route === route.name).length;
		console.log(
			`- ${route.name.padEnd(16)} ${String(route.status).padEnd(4)} ` +
				`${String(route.html.length).padStart(6)} bytes  findings=${routeFindings}`
		);
	}

	if (findings.length > 0) {
		console.log('\n## Findings');
		for (const finding of findings) {
			console.log(`- ${finding.path}:${finding.line} [${finding.type}] ${finding.snippet}`);
		}
	}
	for (const problem of offOrigin) console.log(`\n- Off-origin reference: ${problem}`);
	for (const problem of statusProblems) console.log(`\n- Status mismatch: ${problem}`);

	const failed = findings.length + offOrigin.length + statusProblems.length;
	console.log(failed === 0 ? '\nCSP audit: clean.' : `\nCSP audit: ${failed} problem(s).`);
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
