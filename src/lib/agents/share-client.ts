/**
 * Share-grant client for lesser's agent management plane (lesser v1.6.5).
 *
 * Share-grants are REST-only by lesser design — they sit beside delegation,
 * access leases, and agent update/delete on the agent MANAGEMENT plane, not
 * the CMS data plane, so this is the documented exception to GraphQL-first
 * (docs/planning/agent-share-act-as-m7.md, CMS-consumption audit). The client
 * is deliberately thin: it transmits the four operations lesser defines and
 * surfaces lesser's status codes. It derives nothing about eligibility —
 * whether the caller owns the agent, whether the grantee is local, and
 * whether the instance is new enough to have these routes at all are all
 * lesser's answers, and they arrive as the status codes below.
 *
 * Types come from the vendored generated OpenAPI types
 * (`greater/adapters/rest/generated/lesser-api.ts`), which is read-only;
 * this module is the contentus-owned consumer the planning enumerates.
 *
 * Same-origin by default, like the GraphQL transport: relative paths in the
 * browser, an explicit absolute base only when SSR has no document base.
 */

// Explicit `.ts` extensions, matching `cms/review-transport.ts`: this module
// is loaded straight off disk by `node --test --experimental-strip-types` so
// the shipped client can be driven against a stubbed `fetch`, and Node's ESM
// resolver neither guesses extensions nor knows the `$lib` alias.
import type { components } from '../greater/adapters/rest/generated/lesser-api.ts';

export type AgentShareGrant = components['schemas']['AgentShareGrant'];
export type AgentShareGrantListResponse = components['schemas']['AgentShareGrantListResponse'];

export interface ShareClientOptions {
	/**
	 * Absolute API base for SSR (e.g. `https://instance/api/v1`); omit in the
	 * browser to use the same-origin relative path.
	 */
	endpoint?: string | null;
	/** Bearer token. Share management requires `write`; shared-with-me `read`. */
	accessToken: string;
	signal?: AbortSignal;
}

/** lesser answered with a non-2xx, or the request never reached lesser. */
export class ShareClientError extends Error {
	/** HTTP status, or null when the failure was transport-level. */
	readonly status: number | null;

	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'ShareClientError';
		this.status = status;
	}
}

const AGENTS_PATH = '/api/v1/agents';

function basePath(options: ShareClientOptions): string {
	// An explicit endpoint is an origin (or origin + base path); the agents
	// routes are appended to it. The relative form is same-origin by
	// construction, exactly like `GRAPHQL_PATH`.
	return options.endpoint ? `${options.endpoint}${AGENTS_PATH}` : AGENTS_PATH;
}

async function shareRequest<T>(
	path: string,
	method: 'GET' | 'PUT' | 'DELETE',
	options: ShareClientOptions
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${basePath(options)}${path}`, {
			method,
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${options.accessToken}`,
			},
			credentials: 'same-origin',
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (cause) {
		throw new ShareClientError(cause instanceof Error ? cause.message : 'share request failed');
	}

	if (!response.ok) {
		// lesser's error bodies are JSON, but a pre-v1.6.5 instance answers
		// these routes with whatever its router produces — the status is the
		// honest signal and the body is best-effort context only.
		let detail = '';
		try {
			const body = (await response.json()) as { error?: unknown; message?: unknown };
			const message = body.error ?? body.message;
			if (typeof message === 'string' && message) detail = `: ${message}`;
		} catch {
			// Non-JSON error body; the status already says what matters.
		}
		throw new ShareClientError(
			`share request failed (${response.status})${detail}`,
			response.status
		);
	}

	return (await response.json()) as T;
}

/** `GET /api/v1/agents/{username}/share` — the grants an agent owner has made. */
export async function listShareGrants(
	username: string,
	options: ShareClientOptions
): Promise<AgentShareGrant[]> {
	const response = await shareRequest<AgentShareGrantListResponse>(
		`/${encodeURIComponent(username)}/share`,
		'GET',
		options
	);
	return response.grants;
}

/** `PUT /api/v1/agents/{username}/share/{grantee}` — grant a local account access. */
export async function grantShare(
	username: string,
	grantee: string,
	options: ShareClientOptions
): Promise<AgentShareGrant> {
	return shareRequest<AgentShareGrant>(
		`/${encodeURIComponent(username)}/share/${encodeURIComponent(grantee)}`,
		'PUT',
		options
	);
}

/** `DELETE /api/v1/agents/{username}/share/{grantee}` — revoke a grant. */
export async function revokeShare(
	username: string,
	grantee: string,
	options: ShareClientOptions
): Promise<AgentShareGrant> {
	return shareRequest<AgentShareGrant>(
		`/${encodeURIComponent(username)}/share/${encodeURIComponent(grantee)}`,
		'DELETE',
		options
	);
}

/** `GET /api/v1/agents/shared-with-me` — agents the caller may act as. */
export async function listSharedWithMe(options: ShareClientOptions): Promise<AgentShareGrant[]> {
	const response = await shareRequest<AgentShareGrantListResponse>(
		'/shared-with-me',
		'GET',
		options
	);
	return response.grants;
}
