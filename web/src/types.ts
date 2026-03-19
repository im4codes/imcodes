export type Priority = 0 | 1 | 2 | 3;

export interface TrackerIssue {
  id: string;
  title: string;
  body: string;
  priority: Priority;
  labels: string[];
  url: string;
  assignee?: string;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface AutoFixTaskStatus {
  id: string;
  title: string;
  state: 'planning' | 'design_review' | 'implementing' | 'code_review' | 'approved' | 'done' | 'failed';
  discussionRounds: number;
  maxDiscussionRounds: number;
  coderSession: string;
  auditorSession: string;
  branch?: string;
  issueId?: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface SessionInfo {
  name: string;
  project: string;
  role: 'brain' | `w${number}`;
  agentType: string;
  agentVersion?: string;
  state: 'running' | 'idle' | 'stopped' | 'error' | 'unknown';
  label?: string | null;
  projectDir?: string;
}

export interface ServerInfo {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: number;
}

export type { TerminalDiff } from '../../src/shared/transport/terminal.js';
