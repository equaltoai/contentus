#!/usr/bin/env node
/**
 * Strict JSON reading for the pinned governance inputs.
 *
 * `JSON.parse` is last-wins on duplicate object keys: `{"a":1,"a":2}` parses to
 * `{"a":2}` without complaint. Every pin this repository asserts against is a
 * JSON document a pull request can edit, so a duplicate key is a place where the
 * value a reviewer reads and the value a control enforces are different bytes in
 * the same file. That is not a hypothetical reading hazard; it is the shape a pin
 * edit would take if it wanted to look inert.
 *
 * So the pins are read through here: `JSON.parse` first (it owns syntax), then a
 * second pass over the same text that rejects any object carrying a repeated key.
 * The second pass is a scanner, not a parser — it only has to find string tokens
 * in key position, and the text is already known to be well-formed JSON.
 */
import { readFileSync } from 'node:fs';

/**
 * Walk the already-validated JSON text and collect every object key that appears
 * more than once in the same object. Arrays are tracked only so an element that
 * happens to be a string is never mistaken for a key.
 */
export function duplicateKeys(text) {
	const duplicates = [];
	const stack = [];
	let index = 0;

	const readString = () => {
		// The opening quote is at `index`. JSON.parse already accepted this text,
		// so the only escape that matters here is one that hides a closing quote.
		let cursor = index + 1;
		let value = '';
		while (cursor < text.length) {
			const char = text[cursor];
			if (char === '\\') {
				value += text.slice(cursor, cursor + 2);
				cursor += 2;
				continue;
			}
			if (char === '"') {
				index = cursor + 1;
				return value;
			}
			value += char;
			cursor += 1;
		}
		index = text.length;
		return value;
	};

	while (index < text.length) {
		const char = text[index];
		if (char === '{') {
			stack.push({ kind: 'object', keys: new Set(), path: currentPath(stack) });
			index += 1;
			continue;
		}
		if (char === '[') {
			stack.push({ kind: 'array' });
			index += 1;
			continue;
		}
		if (char === '}' || char === ']') {
			stack.pop();
			index += 1;
			continue;
		}
		if (char === '"') {
			const start = index;
			const value = readString();
			const frame = stack[stack.length - 1];
			if (frame?.kind === 'object') {
				// A string is a key only when the next non-space byte is `:`. Anything
				// else makes it a value, and values never collide.
				let lookahead = index;
				while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
				if (text[lookahead] === ':') {
					if (frame.keys.has(value))
						duplicates.push(`${frame.path ? `${frame.path}.` : ''}${value} (offset ${start})`);
					frame.keys.add(value);
					frame.lastKey = value;
				}
			}
			continue;
		}
		index += 1;
	}
	return duplicates;
}

function currentPath(stack) {
	return stack
		.filter((frame) => frame.kind === 'object' && frame.lastKey)
		.map((frame) => frame.lastKey)
		.join('.');
}

/** Parse JSON text, rejecting duplicate object keys. Throws `SyntaxError`. */
export function parseStrictJson(text, label) {
	const value = JSON.parse(text);
	const duplicates = duplicateKeys(text);
	if (duplicates.length)
		throw new SyntaxError(
			`${label}: duplicate object key(s) — ${duplicates.join(', ')}. ` +
				'JSON.parse is last-wins, so a repeated key means the value a reviewer reads and ' +
				'the value this control enforces are different bytes in the same file.'
		);
	return value;
}

/** Read and strictly parse a JSON file. Throws with the path in the message. */
export function readStrictJson(path, label = path) {
	return parseStrictJson(readFileSync(path, 'utf8'), label);
}
