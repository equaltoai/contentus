#!/usr/bin/env node
/**
 * A deliberately small, dependency-free tar reader for exactly one job: taking a
 * digest-verified archive apart without trusting the archive's own idea of where
 * its members belong.
 *
 * SEC-7 needs to execute code whose provenance is the pinned release asset and
 * nothing else. Verifying a tarball and then running a tree some other script
 * unpacked binds the wrong thing — the digest covers the bytes on disk, not the
 * executable that was produced from them. So the gate unpacks the archive itself,
 * here, at gate time, and this module is the unpacking.
 *
 * Because an archive is attacker-shaped input the moment it is not the pinned one,
 * every member is validated before anything is written:
 *
 *   - only regular files and directories. Symlinks, hardlinks, devices, pax and
 *     GNU long-name extensions are rejected rather than interpreted. A link member
 *     is how an extraction writes outside its destination while every path in the
 *     listing looks contained.
 *   - only plain relative paths. No absolute path, no `..` segment, no `.`
 *     segment, no backslash, no drive letter, no NUL, no repeated separator.
 *   - no duplicate member names, so a later member cannot overwrite an earlier one
 *     after its content was recorded.
 *   - a valid ustar magic and a matching header checksum on every block.
 *
 * The destination is re-checked after path resolution too. That is belt and braces
 * over the name rules above, and it is cheap: an extractor that only validates the
 * name it was given has trusted string handling to establish a filesystem property.
 *
 * This is not a general tar implementation. Anything outside the vocabulary above
 * throws, which is the correct answer for an archive that is supposed to be one
 * exact, pinned npm pack tarball.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(header, offset, length) {
	const text = header
		.toString('ascii', offset, offset + length)
		.replace(/\0[\s\S]*$/, '')
		.trim();
	if (text === '') return 0;
	if (!/^[0-7]+$/.test(text)) throw new Error(`malformed octal tar header field "${text}"`);
	return Number.parseInt(text, 8);
}

function cString(header, offset, length) {
	return header.toString('utf8', offset, offset + length).replace(/\0[\s\S]*$/, '');
}

// The checksum is computed with its own field read as eight spaces. Historic
// writers disagreed on whether the bytes are signed, so both readings are
// accepted — that is the standard tolerance, not a weakening.
function headerChecksumMatches(header) {
	const stored = octal(header, 148, 8);
	let unsigned = 0;
	let signed = 0;
	for (let index = 0; index < BLOCK; index += 1) {
		const byte = index >= 148 && index < 156 ? 0x20 : header[index];
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	return stored === unsigned || stored === signed;
}

function assertSafeMemberName(name) {
	if (!name) throw new Error('archive member with an empty name');
	if (name.includes('\0')) throw new Error(`archive member name contains NUL: ${name}`);
	if (name.includes('\\')) throw new Error(`archive member name contains a backslash: ${name}`);
	if (name.startsWith('/')) throw new Error(`absolute archive member path: ${name}`);
	if (/^[A-Za-z]:/.test(name)) throw new Error(`drive-qualified archive member path: ${name}`);
	for (const segment of name.replace(/\/+$/, '').split('/')) {
		if (segment === '') throw new Error(`empty path segment in archive member: ${name}`);
		if (segment === '.' || segment === '..')
			throw new Error(`relative path segment "${segment}" in archive member: ${name}`);
		if (!/^[A-Za-z0-9._@+-]+$/.test(segment))
			throw new Error(`unmodelled path segment "${segment}" in archive member: ${name}`);
	}
}

/**
 * Read every member of a gzipped tar buffer. Throws on anything outside the
 * vocabulary above; the caller treats a throw as a failed control, not as a
 * member to skip.
 */
export function readTarEntries(archive) {
	const buffer = gunzipSync(archive);
	const entries = [];
	const seen = new Set();
	let offset = 0;
	while (offset + BLOCK <= buffer.length) {
		const header = buffer.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break; // end-of-archive marker
		if (!headerChecksumMatches(header))
			throw new Error(`tar header checksum mismatch at offset ${offset}`);
		if (header.toString('ascii', 257, 262) !== 'ustar')
			throw new Error(`unsupported tar format at offset ${offset}; expected ustar`);
		const prefix = cString(header, 345, 155);
		const name = prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100);
		assertSafeMemberName(name);
		const flag = header[156];
		let kind;
		if (flag === 0 || flag === 0x30) kind = 'file';
		else if (flag === 0x35) kind = 'directory';
		else
			throw new Error(
				`archive member ${name} has type flag ${JSON.stringify(String.fromCharCode(flag))}, ` +
					'which this reader deliberately does not interpret'
			);
		const size = kind === 'file' ? octal(header, 124, 12) : 0;
		offset += BLOCK;
		if (offset + size > buffer.length) throw new Error(`archive member ${name} is truncated`);
		const data = kind === 'file' ? Buffer.from(buffer.subarray(offset, offset + size)) : null;
		offset += Math.ceil(size / BLOCK) * BLOCK;
		const normalized = name.replace(/\/+$/, '');
		if (seen.has(normalized)) throw new Error(`duplicate archive member: ${normalized}`);
		seen.add(normalized);
		entries.push({ name: normalized, kind, size, data });
	}
	return entries;
}

export const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Write every member beneath `stripPrefix` into `targetDirectory`, returning the
 * relative path and content digest of each file written. Members are written
 * 0600: the gate runs the entry point through `node <path>`, so nothing here ever
 * needs to be executable, and a tree that cannot be executed directly is one fewer
 * thing to reason about.
 */
export function extractEntries(entries, targetDirectory, stripPrefix) {
	const root = resolve(targetDirectory);
	const written = [];
	for (const entry of entries) {
		if (entry.name !== stripPrefix.replace(/\/$/, '') && !entry.name.startsWith(stripPrefix))
			throw new Error(`archive member outside ${stripPrefix}: ${entry.name}`);
		const relativePath = entry.name.startsWith(stripPrefix)
			? entry.name.slice(stripPrefix.length)
			: '';
		if (!relativePath) continue;
		const destination = resolve(root, relativePath);
		if (destination !== root && !destination.startsWith(root + sep))
			throw new Error(`archive member escapes the extraction directory: ${entry.name}`);
		if (entry.kind === 'directory') {
			mkdirSync(destination, { recursive: true });
			continue;
		}
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, entry.data, { mode: 0o600 });
		written.push({ path: relativePath, sha256: digestOf(entry.data) });
	}
	return written;
}

/**
 * Every regular file beneath `directory`, as repository-style relative paths. A
 * symlink or any other non-regular entry throws: this walks a tree this process
 * just wrote, so anything else means the extraction did not do what it reported.
 */
export function walkRegularFiles(directory, base = directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new Error(`unexpected symlink in the extracted tree: ${full}`);
		if (entry.isDirectory()) found.push(...walkRegularFiles(full, base));
		else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'));
		else throw new Error(`unexpected non-regular entry in the extracted tree: ${full}`);
	}
	return found;
}
