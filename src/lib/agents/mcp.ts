/**
 * MCP discovery for face 6's detail panel.
 *
 * PORTED FROM SIMULACRUM'S `AgentMcpPanel`, MINUS TWO THINGS, and both
 * subtractions are the point.
 *
 * 1. NO LEASE PLUMBING. sim's panel drives `initialize` / `tools/list` /
 *    `resources/read` over JSON-RPC with a bearer token it obtains from an
 *    agent access lease. contentus has no lease surface and this face is
 *    anonymous-safe, so none of that is here. What replaces it is better than a
 *    degraded version of it: lesser-body publishes the tool registry in the
 *    unauthenticated discovery document, so the catalog this panel shows is
 *    server-stated rather than probed with someone's credentials.
 *
 * 2. NO TRANSPORT DERIVATION. sim's `resolveMcpTransport` rebuilds the MCP URL
 *    from the page origin — `api.` host prefix, `/mcp/<actor>` path, the
 *    protected-resource well-known beneath it. That is a client-side copy of
 *    lesser's `pkg/auth/mcp_access.go` (`BuildPublicMCPAccessBundle`,
 *    `canonicalMCPResourceBaseURL`), and lesser hands contentus the finished
 *    values on `Agent.mcpAccess`. They come from the instance.
 *
 * THE TWO VALUES THAT ARE STILL DERIVED, and why. `mcpAccess` names four URLs;
 * `/.well-known/mcp.json` is not among them. It is derived from the ORIGIN of
 * `mcpAccess.mcpURL` — the host lesser itself just named as the MCP host — and
 * never from `window.location`, which is the app host and a different origin
 * (lesser canonicalises MCP onto `api.<domain>`). Deriving a well-known path
 * beneath a host the instance stated is a much smaller claim than deriving the
 * host, and it is the smallest one that reaches a document contentus needs.
 * That the document is missing is itself a reportable answer. The second is
 * the CSP ceiling for this route, which the server CANNOT read off `mcpAccess`
 * because the detail is a session read; `mcpConnectOriginForInstance` derives
 * it from the page origin using lesser's own canonicalisation rule, and its
 * comment carries the reasoning.
 *
 * BROWSER ONLY. These are live reachability checks against a sibling origin.
 * Running them during SSR would make a cold page render wait on a third host
 * and would report the SSR host's reachability rather than the reader's. The
 * panel's substance — every URL, scope and guidance line — is lesser's and is
 * already in the server's paint; this only adds "and it answered".
 */

/** Everything the panel probes, resolved from lesser's own `mcpAccess`. */
export interface McpProbeTargets {
	/** `mcpAccess.mcpURL`, verbatim. Also the OAuth `resource` value. */
	endpoint: string;
	/** `mcpAccess.protectedResourceURL`, verbatim. */
	protectedResourceUrl: string;
	/**
	 * `/.well-known/mcp.json` beneath the endpoint's origin. The only derived
	 * value here; see the module header.
	 */
	discoveryUrl: string;
	/** The origin every probe targets, for the CSP `connect-src` allowance. */
	origin: string;
}

/**
 * Resolve what can be probed for an agent, or null.
 *
 * Null when lesser published no MCP URL — `BuildPublicMCPAccessBundle` returns
 * a guidance-only bundle with empty URLs when it cannot name a base URL or an
 * actor. That is a real state ("this instance publishes no MCP surface for this
 * agent"), not a failure, and the panel renders it as one.
 */
export function resolveMcpProbeTargets(access: {
	mcpURL: string | null;
	protectedResourceURL: string | null;
}): McpProbeTargets | null {
	const endpoint = access.mcpURL?.trim();
	if (!endpoint) return null;

	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return null;
	}
	if (!url.hostname) return null;

	return {
		endpoint,
		// lesser states this one; it is only defaulted when absent, and then only
		// to the conventional path beneath the same origin.
		protectedResourceUrl:
			access.protectedResourceURL?.trim() ||
			new URL('/.well-known/oauth-protected-resource', url.origin).toString(),
		discoveryUrl: new URL('/.well-known/mcp.json', url.origin).toString(),
		origin: url.origin,
	};
}

/**
 * The MCP origin the agent-detail route's CSP must permit, derived from the
 * origin the page was served from — or null.
 *
 * WHY THIS DERIVES A HOST THE MODULE HEADER SAYS NOT TO DERIVE. The probe
 * TARGETS still come from lesser's `mcpAccess`, verbatim; nothing here
 * rebuilds them. But the detail route is a session read — lesser's GraphQL
 * gateway refuses anonymous `agent(username)` operations before the resolver
 * runs — so the server pass no longer has the agent's `mcpAccess` in hand when
 * it writes `connect-src`, and a policy that can only name the origin after
 * the answer arrives would CSP-block the very probes it exists to permit. The
 * ceiling therefore comes from the one fact the server does know: where this
 * instance lives. It applies lesser's OWN canonicalisation rule
 * (`canonicalMCPResourceBaseURL`, `pkg/auth/mcp_access.go`): `api.` prefixed
 * onto the instance host, port preserved, local hostnames left alone.
 *
 * The consequence of a wrong derivation is honest degradation, never a
 * widened hole: the allowance is one sibling origin on one route, the probes
 * still fire only at the URLs lesser stated for the agent, and if an instance
 * publishes its MCP surface somewhere else the panel reports it unreachable
 * rather than connecting somewhere unexpected.
 */
export function mcpConnectOriginForInstance(origin: string | null | undefined): string | null {
	if (!origin) return null;

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return null;
	}
	if (!url.hostname) return null;

	// lesser keeps MCP on the instance host itself for local deployments
	// (`isLocalMCPHostname`), so those probes are same-origin and 'self'
	// already covers them — no widening to give.
	const host = url.hostname.toLowerCase();
	if (host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost'))
		return null;

	// Already an api host — do not stack another prefix onto it.
	const apiHost = host.startsWith('api.') ? host : `api.${host}`;
	const port = url.port ? `:${url.port}` : '';
	return `${url.protocol}//${apiHost}${port}`;
}

/* -------------------------------------------------------------------------
 * Documents
 * ---------------------------------------------------------------------- */

/** A tool as lesser-body publishes it in the discovery document. */
export interface McpToolHint {
	name: string;
	description: string | null;
}

/** `/.well-known/mcp.json`, as lesser-body's `mcpWellKnownDoc` serializes it. */
export interface McpDiscoveryDocument {
	name: string | null;
	version: string | null;
	endpoint: string | null;
	capabilities: { name: string; enabled: boolean }[];
	authType: string | null;
	authScopes: string[];
	authNotes: string | null;
	tools: McpToolHint[];
}

/** `/.well-known/oauth-protected-resource/...`, RFC 9728. */
export interface OAuthProtectedResourceDocument {
	resource: string | null;
	authorizationServers: string[];
	scopesSupported: string[];
	bearerMethodsSupported: string[];
}

export type ProbeState<T> =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'ready'; document: T }
	| { status: 'error'; message: string };

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
		: [];
}

export function toMcpDiscoveryDocument(raw: unknown): McpDiscoveryDocument {
	const node = record(raw) ?? {};
	const capabilities = record(node.capabilities) ?? {};
	const auth = record(node.auth) ?? {};

	return {
		name: str(node.name),
		version: str(node.version),
		endpoint: str(node.endpoint),
		// Rendered as the server's own map rather than a fixed list of the four
		// capabilities that exist today: lesser-body adds keys (`tasks` appears
		// only when task discovery is on), and a hardcoded list would silently
		// drop whatever it does not know about.
		capabilities: Object.entries(capabilities).map(([name, enabled]) => ({
			name,
			enabled: enabled === true,
		})),
		authType: str(auth.type),
		authScopes: strings(auth.scopes),
		authNotes: str(auth.notes),
		tools: Array.isArray(node.tools)
			? node.tools
					.map((tool) => {
						const entry = record(tool);
						const name = entry ? str(entry.name) : null;
						return name ? { name, description: entry ? str(entry.description) : null } : null;
					})
					.filter((tool): tool is McpToolHint => tool !== null)
			: [],
	};
}

export function toOAuthProtectedResourceDocument(raw: unknown): OAuthProtectedResourceDocument {
	const node = record(raw) ?? {};

	return {
		resource: str(node.resource),
		authorizationServers: strings(node.authorization_servers),
		scopesSupported: strings(node.scopes_supported),
		bearerMethodsSupported: strings(node.bearer_methods_supported),
	};
}

/* -------------------------------------------------------------------------
 * Probes
 * ---------------------------------------------------------------------- */

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		headers: { accept: 'application/json' },
		// The discovery documents are public and these requests must stay
		// anonymous: no cookies, no credentials, to a sibling origin.
		credentials: 'omit',
		...(signal ? { signal } : {}),
	});

	if (!response.ok) {
		throw new Error(`The instance answered ${response.status} for this document.`);
	}

	return response.json();
}

/**
 * Probe both discovery documents.
 *
 * Reported separately rather than as one result, because they fail for
 * different reasons and mean different things: a missing `mcp.json` says the
 * MCP server is not publishing a catalog, while a missing protected-resource
 * document says the OAuth surface a client needs to authorize against is not
 * discoverable. Collapsing them into one "MCP unreachable" would lose which.
 */
export async function probeMcpDiscovery(
	targets: McpProbeTargets,
	signal?: AbortSignal
): Promise<ProbeState<McpDiscoveryDocument>> {
	try {
		return {
			status: 'ready',
			document: toMcpDiscoveryDocument(await fetchJson(targets.discoveryUrl, signal)),
		};
	} catch (error) {
		return { status: 'error', message: probeMessage(error) };
	}
}

export async function probeProtectedResource(
	targets: McpProbeTargets,
	signal?: AbortSignal
): Promise<ProbeState<OAuthProtectedResourceDocument>> {
	try {
		return {
			status: 'ready',
			document: toOAuthProtectedResourceDocument(
				await fetchJson(targets.protectedResourceUrl, signal)
			),
		};
	} catch (error) {
		return { status: 'error', message: probeMessage(error) };
	}
}

function probeMessage(error: unknown): string {
	if (error instanceof Error && error.name === 'AbortError') return 'The check was cancelled.';
	if (error instanceof Error && error.message) return error.message;
	return 'The document could not be read.';
}

/* -------------------------------------------------------------------------
 * Client configuration
 * ---------------------------------------------------------------------- */

export interface McpClientConfig {
	id: string;
	label: string;
	/** Where the snippet goes, so a reader knows what to do with it. */
	destination: string;
	language: 'json' | 'shell';
	body: string;
}

/**
 * The half of `mcpAccess` that is addresses rather than probe targets.
 *
 * Taken as the bundle rather than as loose strings so a value cannot be
 * substituted for another that happens to be the same type — which is exactly
 * how `authorization_server` came to be filled with the protected-resource URL.
 */
export interface McpAccessBundle {
	authorizationServerURL: string | null;
	registrationURL: string | null;
	scopes: string[];
}

/**
 * Copy-paste configurations for connecting a client to this agent's MCP server.
 *
 * EVERY VALUE COMES FROM LESSER, AND EACH FROM THE RIGHT FIELD. `mcpAccess`
 * names four URLs and they are four different things: `mcpURL` is the MCP server
 * and the RFC 8707 `resource`; `protectedResourceURL` is the RFC 9728 metadata
 * ABOUT that resource; `authorizationServerURL` is the authorization server's
 * own metadata; `registrationURL` is RFC 7591 dynamic registration. lesser
 * canonicalises the first two onto `api.<domain>` and leaves the last two on the
 * apex, so they are not even the same host — and a config that pointed a client
 * at the protected-resource document as its authorization server would send it
 * to fetch metadata that cannot answer `/authorize`.
 *
 * A field lesser did not publish is named as unpublished, not defaulted. The
 * protected-resource document's `authorization_servers` array is where a client
 * discovers the server in that case, and saying so is more use than a URL
 * contentus guessed.
 *
 * No token is embedded and none is invented — the snippets carry a placeholder,
 * because a token is minted through the OAuth flow the discovery documents
 * describe, and a config that looked ready to run would be advertising a
 * credential contentus never had.
 */
export function mcpClientConfigs(
	agentUsername: string,
	targets: McpProbeTargets,
	access: McpAccessBundle
): McpClientConfig[] {
	const serverKey = `lesser-${agentUsername}`;
	const scopeList = access.scopes.length ? access.scopes : ['read'];

	return [
		{
			id: 'claude-code',
			label: 'Claude Code',
			destination: '.mcp.json',
			language: 'json',
			body: JSON.stringify(
				{
					mcpServers: {
						[serverKey]: {
							type: 'http',
							url: targets.endpoint,
							headers: { Authorization: 'Bearer <access-token>' },
						},
					},
				},
				null,
				2
			),
		},
		{
			id: 'oauth',
			label: 'OAuth parameters',
			destination: 'Authorization request',
			language: 'json',
			body: JSON.stringify(
				{
					// RFC 8707: the resource value IS the MCP URL. lesser's own guidance
					// says so, and it is repeated here rather than restated in prose so
					// the value can be copied without transcription.
					resource: targets.endpoint,
					protected_resource_metadata: targets.protectedResourceUrl,
					authorization_server:
						access.authorizationServerURL ??
						'<from the protected-resource document’s authorization_servers>',
					registration_endpoint:
						access.registrationURL ?? '<from the authorization server document>',
					scope: scopeList.join(' '),
				},
				null,
				2
			),
		},
		{
			id: 'probe',
			label: 'Verify from a shell',
			destination: 'Terminal',
			language: 'shell',
			body: [
				`curl -s ${targets.discoveryUrl} | jq`,
				`curl -s ${targets.protectedResourceUrl} | jq`,
			].join('\n'),
		},
	];
}
