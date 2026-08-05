/**
 * GraphQL consumption for face 7's owned-drone roster.
 *
 * A drone is an Agent before soul promotion. This module therefore reuses the
 * Agent projection already proven by face 6 and adds only the optional
 * `droneWorkflow` read. It does not infer lifecycle state: every status comes
 * from lesser's GraphQL response.
 */

import {
	AGENT_TYPES,
	fetchMyAgents,
	isAgentType,
	type AgentRequestContext,
	type AgentSummary,
	type AgentType,
} from '../agents/contract.ts';
import { graphqlRequest, GraphQLTransportError, type GraphQLError } from '../cms/graphql.ts';

export { AGENT_TYPES, type AgentType };

export const DEFAULT_DRONE_SCOPES = ['read', 'write', 'follow'] as const;
export const DEFAULT_DRONE_VERSION = '1.0.0';

export interface DroneWorkflowStatus {
	username: string;
	currentPhase: string;
	currentState: string;
	identityLabel: string | null;
	lifecycleState: string | null;
	soulBindingState: string | null;
}

export interface OwnedDrone {
	agent: AgentSummary;
	/** Null means lesser returned no workflow for this drone. */
	workflow: DroneWorkflowStatus | null;
	/** A failed optional workflow read never turns a real roster into an empty one. */
	workflowUnavailable: boolean;
}

export type DroneFailureReason =
	'unauthenticated' | 'insufficient-scope' | 'forbidden' | 'transport';

export interface DroneFailure {
	reason: DroneFailureReason;
	message: string;
}

export type DroneRosterResult =
	{ ok: true; drones: OwnedDrone[] } | { ok: false; failure: DroneFailure };

export interface DroneCreationDraft {
	username: string;
	displayName: string;
	bio: string;
	agentType: AgentType;
	scopes: string[];
}

export interface DroneCreationInput {
	agentUsername: string;
	displayName: string;
	bio?: string;
	scopes: string[];
	agentType: AgentType;
	agentVersion: string;
	version: string;
}

export interface DroneCredentials {
	username: string;
	displayName: string;
	accessToken: string;
	refreshToken: string;
	tokenType: string;
	scope: string;
	createdAt: string;
	expiresIn: number;
}

export type DroneCreationFailureReason =
	'policy-disabled' | 'unauthenticated' | 'forbidden' | 'validation' | 'transport';

export interface DroneCreationFailure {
	reason: DroneCreationFailureReason;
	message: string;
}

export type DroneCreationResult =
	{ ok: true; credentials: DroneCredentials } | { ok: false; failure: DroneCreationFailure };

export type DroneRegistrationPolicy = 'enabled' | 'disabled' | 'unknown';

export interface DroneCreationValidation {
	ok: boolean;
	errors: Partial<Record<'username' | 'displayName' | 'bio' | 'agentType' | 'scopes', string>>;
	input: DroneCreationInput | null;
}

/** Broad `write`, the scope the M7 route requires and requests through auth-ui. */
export function hasWriteScope(scope: string | null | undefined): boolean {
	return (scope ?? '')
		.split(/\s+/)
		.map((value) => value.trim())
		.filter(Boolean)
		.includes('write');
}

export const DRONE_WORKFLOW_QUERY = `
	query ContentusDroneWorkflow($username: String!) {
		droneWorkflow(username: $username) {
			username
			currentPhase
			currentState
			identitySemantics {
				identityLabel
				lifecycleState
				soulBindingState
			}
		}
	}
`;

/**
 * The policy field is admin-readable. A write-scoped non-admin is expected to
 * receive a refusal; that means "unknown", never "enabled". delegateToAgent
 * remains the authoritative policy check for those callers.
 */
export const DRONE_REGISTRATION_POLICY_QUERY = `
	query ContentusDroneRegistrationPolicy {
		adminAgentPolicy {
			allowAgents
			allowAgentRegistration
		}
	}
`;

export const DELEGATE_TO_AGENT_MUTATION = `
	mutation ContentusDelegateToAgent($input: DelegateToAgentInput!) {
		delegateToAgent(input: $input) {
			agent { username displayName }
			accessToken
			refreshToken
			tokenType
			scope
			createdAt
			expiresIn
		}
	}
`;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function finite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requestOptions(ctx: AgentRequestContext) {
	return {
		endpoint: ctx.endpoint ?? null,
		...(ctx.accessToken ? { accessToken: ctx.accessToken } : {}),
		...(ctx.signal ? { signal: ctx.signal } : {}),
	};
}

export function toDroneWorkflowStatus(raw: unknown): DroneWorkflowStatus | null {
	const node = record(raw);
	const username = str(node?.username);
	const currentPhase = str(node?.currentPhase);
	const currentState = str(node?.currentState);
	if (!username || !currentPhase || !currentState) return null;

	const identity = record(node?.identitySemantics);
	return {
		username,
		currentPhase,
		currentState,
		identityLabel: str(identity?.identityLabel),
		lifecycleState: str(identity?.lifecycleState),
		soulBindingState: str(identity?.soulBindingState),
	};
}

export async function fetchDroneWorkflow(
	ctx: AgentRequestContext,
	username: string
): Promise<{ ok: true; workflow: DroneWorkflowStatus | null } | { ok: false }> {
	if (!ctx.accessToken) return { ok: false };
	try {
		const result = await graphqlRequest<{ droneWorkflow: unknown }>(
			DRONE_WORKFLOW_QUERY,
			{ username },
			requestOptions(ctx)
		);
		if (result.errors.length) return { ok: false };
		return { ok: true, workflow: toDroneWorkflowStatus(result.data?.droneWorkflow) };
	} catch {
		return { ok: false };
	}
}

export async function fetchDroneRoster(ctx: AgentRequestContext): Promise<DroneRosterResult> {
	const roster = await fetchMyAgents(ctx);
	if (!roster.ok) {
		const reason = roster.failure.reason;
		return {
			ok: false,
			failure:
				reason === 'unauthenticated'
					? { reason, message: 'Sign in to see the drones you own.' }
					: reason === 'forbidden'
						? { reason, message: roster.failure.message }
						: { reason: 'transport', message: roster.failure.message },
		};
	}

	const workflows = await Promise.all(
		roster.agents.map((agent) => fetchDroneWorkflow(ctx, agent.username))
	);
	return {
		ok: true,
		drones: roster.agents.map((agent, index) => ({
			agent,
			workflow: workflows[index]?.ok ? workflows[index].workflow : null,
			workflowUnavailable: workflows[index]?.ok !== true,
		})),
	};
}

/** Mirrors lesser's ValidateUsername / ValidateDisplayName / ValidateAccountBio limits. */
export function validateDroneCreation(draft: DroneCreationDraft): DroneCreationValidation {
	const username = draft.username.trim();
	const displayName = draft.displayName.trim();
	const bio = draft.bio.trim();
	const scopes = [...new Set(draft.scopes.map((scope) => scope.trim()).filter(Boolean))];
	const errors: DroneCreationValidation['errors'] = {};

	if (!username) errors.username = 'Drone username is required.';
	else if (!/^[a-zA-Z0-9_-]{1,30}$/.test(username)) {
		errors.username =
			'Use 1–30 letters, numbers, underscores, or hyphens. Spaces and @ are not allowed.';
	}

	if (!displayName) errors.displayName = 'Display name is required.';
	else if (new TextEncoder().encode(displayName).length > 30) {
		errors.displayName = 'Display name must be no more than 30 UTF-8 bytes.';
	}

	if (new TextEncoder().encode(bio).length > 500) {
		errors.bio = 'Bio must be no more than 500 UTF-8 bytes.';
	}

	if (!isAgentType(draft.agentType)) errors.agentType = 'Choose a supported agent type.';
	if (!scopes.length) errors.scopes = 'Select at least one delegated scope.';

	if (Object.keys(errors).length) return { ok: false, errors, input: null };
	return {
		ok: true,
		errors,
		input: {
			agentUsername: username,
			displayName,
			...(bio ? { bio } : {}),
			scopes,
			agentType: draft.agentType,
			agentVersion: DEFAULT_DRONE_VERSION,
			version: DEFAULT_DRONE_VERSION,
		},
	};
}

export async function fetchDroneRegistrationPolicy(
	ctx: AgentRequestContext
): Promise<DroneRegistrationPolicy> {
	if (!ctx.accessToken) return 'unknown';
	try {
		const result = await graphqlRequest<{ adminAgentPolicy: unknown }>(
			DRONE_REGISTRATION_POLICY_QUERY,
			{},
			requestOptions(ctx)
		);
		const policy = record(result.data?.adminAgentPolicy);
		if (!policy) return 'unknown';
		return policy.allowAgents === false || policy.allowAgentRegistration === false
			? 'disabled'
			: policy.allowAgents === true && policy.allowAgentRegistration === true
				? 'enabled'
				: 'unknown';
	} catch {
		return 'unknown';
	}
}

export function isDroneRegistrationDisabledError(errors: GraphQLError[]): boolean {
	return errors.some((error) => {
		const message = error.message.toLowerCase();
		return (
			message.includes('agent registration is disabled') || message.includes('agents are disabled')
		);
	});
}

function droneCreationFailure(errors: GraphQLError[]): DroneCreationFailure {
	if (isDroneRegistrationDisabledError(errors)) {
		return {
			reason: 'policy-disabled',
			message: 'This instance does not currently allow new drone registration.',
		};
	}
	const message = errors.map((error) => error.message.toLowerCase()).join(' ');
	if (
		message.includes('authentication required') ||
		message.includes('unauthenticated') ||
		message.includes('insufficient scope')
	) {
		return {
			reason: 'unauthenticated',
			message:
				'Your Lesser session is not authorized to create this drone. Reauthorize with write.',
		};
	}
	if (message.includes('not authorized') || message.includes('forbidden')) {
		return {
			reason: 'forbidden',
			message: 'This instance did not authorize creation of that drone.',
		};
	}
	if (message.includes('username') || message.includes('display_name') || message.includes('bio')) {
		return {
			reason: 'validation',
			message: errors[0]?.message ?? 'Lesser rejected the drone details.',
		};
	}
	return {
		reason: 'transport',
		message: errors[0]?.message ?? 'This instance could not create the drone.',
	};
}

export async function delegateToDrone(
	ctx: AgentRequestContext,
	input: DroneCreationInput
): Promise<DroneCreationResult> {
	if (!ctx.accessToken) {
		return {
			ok: false,
			failure: { reason: 'unauthenticated', message: 'Sign in with write to create a drone.' },
		};
	}

	try {
		const result = await graphqlRequest<{ delegateToAgent: unknown }>(
			DELEGATE_TO_AGENT_MUTATION,
			{ input },
			requestOptions(ctx)
		);
		if (result.errors.length) return { ok: false, failure: droneCreationFailure(result.errors) };

		const payload = record(result.data?.delegateToAgent);
		const agent = record(payload?.agent);
		const username = str(agent?.username);
		const displayName = str(agent?.displayName);
		const accessToken = str(payload?.accessToken);
		const refreshToken = str(payload?.refreshToken);
		const tokenType = str(payload?.tokenType);
		const scope = str(payload?.scope);
		const createdAt = str(payload?.createdAt);
		const expiresIn = finite(payload?.expiresIn);

		if (
			!username ||
			!displayName ||
			!accessToken ||
			!refreshToken ||
			!tokenType ||
			!scope ||
			!createdAt ||
			expiresIn === null
		) {
			return {
				ok: false,
				failure: {
					reason: 'transport',
					message:
						'Lesser returned an incomplete delegation response. Check your roster before trying again.',
				},
			};
		}

		return {
			ok: true,
			credentials: {
				username,
				displayName,
				accessToken,
				refreshToken,
				tokenType,
				scope,
				createdAt,
				expiresIn,
			},
		};
	} catch (error) {
		return {
			ok: false,
			failure: {
				reason: 'transport',
				message:
					error instanceof GraphQLTransportError
						? 'This instance did not answer the drone creation request. Check your roster before retrying.'
						: 'The drone creation request could not be completed. Check your roster before retrying.',
			},
		};
	}
}
