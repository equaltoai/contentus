/**
 * GraphQL consumption for face 7's owned-drone roster.
 *
 * A drone is an Agent before soul promotion. This module therefore reuses the
 * Agent projection already proven by face 6 and adds only the optional
 * `droneWorkflow` read. It does not infer lifecycle state: every status comes
 * from lesser's GraphQL response.
 */

import { fetchMyAgents, type AgentRequestContext, type AgentSummary } from '../agents/contract.ts';
import { graphqlRequest } from '../cms/graphql.ts';

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

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
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
