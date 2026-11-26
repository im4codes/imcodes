import type { SessionAgentType } from './agent-types.js';

export const AGENT_AVAILABILITY_MSG = {
  DETECT: 'session.detect_agents',
  RESULT: 'session.agents_availability',
} as const;

export interface AgentAvailabilityEntry {
  installed: boolean;
  reason?: string;
}

export type AgentAvailabilityMap = Partial<Record<SessionAgentType, AgentAvailabilityEntry>> &
  Record<string, AgentAvailabilityEntry | undefined>;

export interface SessionAgentsAvailabilityMessage {
  type: typeof AGENT_AVAILABILITY_MSG.RESULT;
  agents: AgentAvailabilityMap;
  checkedAt: number;
}
