/**
 * PKCE helpers (RFC 7636, S256 only).
 *
 * Ported from the proven simulacrum implementation
 * (`../simulacrum/src/lib/auth/pkce.ts`). Web Crypto only — no dependency, no
 * polyfill, nothing that could silently degrade to `plain`.
 */

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateRandomString(bytesLength: number): string {
	const bytes = new Uint8Array(bytesLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
	const codeVerifier = generateRandomString(32);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
	const codeChallenge = base64UrlEncode(new Uint8Array(digest));
	return { codeVerifier, codeChallenge };
}
