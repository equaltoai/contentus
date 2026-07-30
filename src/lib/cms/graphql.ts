import { GRAPHQL_PATH } from './origin';

/**
 * Minimal GraphQL transport over lesser's same-origin `/api/graphql`.
 *
 * GraphQL-first is a contract rule, not a preference: REST is reserved for the
 * auth/wallet exception only (product design §3, §8). This client is
 * deliberately tiny — contentus needs POST-a-document, not a cache layer, and
 * a smaller surface is a smaller thing to get wrong under SSR.
 *
 * Anonymous by default. An access token is attached only when one is passed
 * explicitly, so the public article surfaces stay anonymous-safe by
 * construction rather than by remembering to opt out.
 */

export interface GraphQLError {
	message: string;
	path?: (string | number)[];
	extensions?: Record<string, unknown>;
}

export interface GraphQLResult<T> {
	data: T | null;
	errors: GraphQLError[];
}

export interface GraphQLRequestOptions {
	/** Absolute endpoint for SSR; omit in the browser to use the relative path. */
	endpoint?: string | null;
	/** Bearer token. Omitted entirely for anonymous reads. */
	accessToken?: string | null;
	signal?: AbortSignal;
}

/** Transport-level failure (network, non-JSON body, HTTP error). */
export class GraphQLTransportError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = 'GraphQLTransportError';
		this.status = status;
	}
}

export async function graphqlRequest<T>(
	query: string,
	variables: Record<string, unknown> = {},
	options: GraphQLRequestOptions = {}
): Promise<GraphQLResult<T>> {
	const endpoint = options.endpoint ?? GRAPHQL_PATH;

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json',
	};
	if (options.accessToken) {
		headers.authorization = `Bearer ${options.accessToken}`;
	}

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify({ query, variables }),
			credentials: 'same-origin',
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (cause) {
		throw new GraphQLTransportError(
			cause instanceof Error ? cause.message : 'GraphQL request failed'
		);
	}

	const text = await response.text();

	let parsed: { data?: T; errors?: GraphQLError[] };
	try {
		parsed = JSON.parse(text) as { data?: T; errors?: GraphQLError[] };
	} catch {
		// A non-JSON body means we did not reach the GraphQL handler at all
		// (proxy error page, auth redirect, 502). Surface it as transport, not
		// as a contract error — the distinction drives which state renders.
		throw new GraphQLTransportError(
			`GraphQL endpoint returned a non-JSON response (${response.status})`,
			response.status
		);
	}

	// GraphQL reports field-level failures with HTTP 200 and an `errors` array;
	// a non-2xx with a well-formed GraphQL body is still worth surfacing as data
	// + errors rather than discarding the partial result.
	if (!response.ok && !parsed.errors && parsed.data === undefined) {
		throw new GraphQLTransportError(`GraphQL request failed (${response.status})`, response.status);
	}

	return { data: parsed.data ?? null, errors: parsed.errors ?? [] };
}

/**
 * Whether a GraphQL error set indicates the instance has CMS long-form
 * disabled, rather than something being broken.
 *
 * lesser gates the CMS surface instance-wide (`CMSLongFormEnabled`); when it is
 * off, the article resolvers return a feature-gate error. That is a designed
 * state to render gracefully — product design §5 is explicit that it must not
 * surface as an error.
 */
export function isFeatureDisabledError(errors: GraphQLError[]): boolean {
	return errors.some((error) => {
		const message = error.message.toLowerCase();
		return (
			message.includes('not enabled') ||
			message.includes('disabled') ||
			message.includes('long-form') ||
			message.includes('long form')
		);
	});
}
