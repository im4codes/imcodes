/**
 * Multi-agent discussion orchestrator.
 * Manages 2-3 agent sub-sessions in a structured multi-round discussion with a final verdict.
 */

import { sessionExists, sendKeysDelayedEnter } from '../agent/tmux.js';
import { startSubSession, stopSubSession } from './subsession-manager.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from '../util/logger.js';
import type { AgentType } from '../agent/detect.js';

const IDLE_TIMEOUT = 300_000;      // max total wall time per response
const ACTIVE_TIMEOUT = 120_000;    // timeout only when agent is idle with no file growth
const IDLE_POLL_INTERVAL = 3_000;

// Model strength ranking (for auto-selecting the verdict participant)
const MODEL_STRENGTH: Record<string, number> = {
  opus: 100,
  sonnet: 80,
  codex: 50,
  gemini: 50,
};

const BUILTIN_ROLES: Record<string, { label: string; prompt: string }> = {
  critic: {
    label: 'Critic',
    prompt:
      'You are a rigorous critic. Focus on finding flaws, risks, and inconsistencies in the proposal. Challenge every point and do not agree easily. If you spot security vulnerabilities, performance issues, or architectural defects, call them out.',
  },
  pragmatist: {
    label: 'Pragmatist',
    prompt:
      'You are a pragmatic engineer. Focus on feasibility, implementation cost, and timeline. Evaluate whether the technology choices are mature, whether the team can execute, and whether simpler alternatives exist. Avoid over-engineering.',
  },
  innovator: {
    label: 'Innovator',
    prompt:
      'You are a creative thinker. Examine problems from different angles and propose unconventional solutions. Focus on user experience, long-term evolution, and technology trends. Challenge existing assumptions, but keep suggestions actionable.',
  },
};

// ── Types ─────────────────────────────────────────────────────────────────

type DiscussionState = 'setup' | 'running' | 'verdict' | 'done' | 'failed';

interface DiscussionParticipant {
  subSessionId: string;
  sessionName: string;
  agentType: AgentType;
  model?: string;
  roleId: string;
  roleLabel: string;
  rolePrompt: string;
  reused: boolean;
}

interface Discussion {
  id: string;
  serverId: string;
  topic: string;
  cwd: string;
  state: DiscussionState;
  participants: DiscussionParticipant[];
  currentRound: number;
  maxRounds: number;
  filePath: string;
  currentSpeakerIdx: number;
  verdictParticipantIdx: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
  conclusion?: string;
}

// ── State ──────────────────────────────────────────────────────────────────

const discussions = new Map<string, Discussion>();

// ── Helpers ────────────────────────────────────────────────────────────────

function participantStrength(p: DiscussionParticipant): number {
  if (p.model) return MODEL_STRENGTH[p.model] ?? 40;
  if (p.agentType === 'claude-code') return 80; // default sonnet
  return 40;
}

function buildFileHeader(d: Discussion): string {
  const lines = [`# Discussion: ${d.topic}\n`];
  lines.push(`Started: ${new Date(d.startedAt).toISOString()}`);
  lines.push(`Max Rounds: ${d.maxRounds}\n`);
  lines.push('Participants:');
  for (const p of d.participants) {
    const modelTag = p.model ? ` / ${p.model}` : '';
    lines.push(`- ${p.roleLabel} (${p.agentType}${modelTag})`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildRoundPrompt(
  discussionFilePath: string,
  participant: DiscussionParticipant,
  round: number,
  maxRounds: number,
  sectionHeader: string,
): string {
  const roleBlock = [`Your role: ${participant.roleLabel}`, participant.rolePrompt].join('\n');

  if (round === 1) {
    return [
      `You are participating in a multi-agent discussion. Round ${round}/${maxRounds}.`,
      '',
      roleBlock,
      '',
      `Read the discussion file at: ${discussionFilePath}`,
      'It contains the topic and context for this discussion.',
      '',
      'Give your perspective based on your role. Be specific, constructive, under 500 words.',
      '',
      `IMPORTANT: Append your response to the SAME file: ${discussionFilePath}`,
      `Start with this exact header line: ${sectionHeader}`,
      'Then write your response below it. Keep it concise.',
    ].join('\n');
  }

  return [
    `Multi-agent discussion, round ${round}/${maxRounds}.`,
    '',
    roleBlock,
    '',
    `Read the full discussion so far at: ${discussionFilePath}`,
    '',
    'Respond to previous participants:',
    '- What do you agree/disagree with and why?',
    '- New insights or concerns?',
    'Under 500 words.',
    '',
    `IMPORTANT: Append your response to the SAME file: ${discussionFilePath}`,
    `Start with this exact header line: ${sectionHeader}`,
    'Then write your response below it. Keep it concise.',
  ].join('\n');
}

function buildVerdictPrompt(discussionFilePath: string, judge: DiscussionParticipant, sectionHeader: string): string {
  return [
    'You are the final arbiter of this multi-agent discussion.',
    `Your perspective: ${judge.roleLabel} — ${judge.rolePrompt}`,
    '',
    `Read the full discussion transcript at: ${discussionFilePath}`,
    '',
    'Deliver a final verdict:',
    '1. Summarize the key points of agreement and disagreement',
    '2. Evaluate the strongest arguments from each participant',
    '3. Make a clear, actionable final decision or recommendation',
    '',
    'Be decisive. This is the final word.',
    '',
    `IMPORTANT: Append your verdict to the SAME file: ${discussionFilePath}`,
    `Start with this exact header line: ${sectionHeader}`,
    'Then write your verdict below it.',
  ].join('\n');
}

/**
 * Wait for agent to finish writing to the discussion file.
 * Dual confirmation: file must have grown AND agent must be idle.
 * Either condition alone is not sufficient — prevents false positives from both sides.
 */
async function waitForResponse(
  filePath: string,
  previousSize: number,
  sessionName: string,
  timeoutMs: number,
): Promise<string> {
  const { stat } = await import('node:fs/promises');
  const { readSubSessionResponse } = await import('./subsession-manager.js');
  const start = Date.now();
  let fileGrew = false;
  let lastActivityAt = Date.now(); // tracks when agent was last seen active

  while (Date.now() - start < timeoutMs) {
    // Check file growth
    try {
      const s = await stat(filePath);
      if (s.size > previousSize) fileGrew = true;
    } catch {
      // File may not exist yet
    }

    // Check agent idle
    const result = await readSubSessionResponse(sessionName).catch(() => ({ status: 'working' as const }));
    const isIdle = result.status === 'idle';

    // Both conditions met → done
    if (fileGrew && isIdle) {
      // Small grace period to ensure file write is fully flushed
      await new Promise<void>((r) => setTimeout(r, 1000));
      const content = await readFile(filePath);
      return content.subarray(previousSize).toString('utf8').trim();
    }

    // Activity-based timeout: only count idle time with no file growth
    if (!isIdle) {
      lastActivityAt = Date.now();
    }
    const idleDuration = Date.now() - lastActivityAt;
    if (idleDuration > ACTIVE_TIMEOUT && !fileGrew) {
      break; // agent has been idle too long without producing output
    }

    await new Promise<void>((r) => setTimeout(r, IDLE_POLL_INTERVAL));
  }

  // Timeout — if file grew, return what we have even if agent isn't idle
  if (fileGrew) {
    const content = await readFile(filePath);
    const newContent = content.subarray(previousSize).toString('utf8').trim();
    if (newContent.length > 0) {
      logger.warn({ sessionName, filePath }, 'Agent not idle at timeout but file has content, using it');
      return newContent;
    }
  }

  throw new Error(`Timed out waiting for response (file grew: ${fileGrew}, session: ${sessionName})`);
}

async function waitAllReady(d: Discussion, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (const p of d.participants) {
    while (Date.now() - start < timeoutMs) {
      if (await sessionExists(p.sessionName)) break;
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
    if (!await sessionExists(p.sessionName)) {
      throw new Error(`Timed out waiting for ${p.sessionName} to start`);
    }
  }
}

// ── Title generation ──────────────────────────────────────────────────────

async function generateTitle(sessionName: string, topic: string, titleFile: string): Promise<string> {
  await import('node:fs/promises').then((fs) => fs.writeFile(titleFile, '', 'utf8'));

  const prompt = [
    'Generate a short filename title (max 20 characters) for a discussion document.',
    'Use the SAME LANGUAGE as the topic below. Output ONLY the title text, nothing else.',
    'No quotes, no file extension, no explanation.',
    '',
    `Topic: ${topic}`,
    '',
    `Write the title to this file: ${titleFile}`,
  ].join('\n');

  await sendKeysDelayedEnter(sessionName, prompt);
  const raw = await waitForResponse(titleFile, 0, sessionName, 30_000).catch(() => '');

  const cleaned = raw
    .split('\n')[0] // first line only
    .replace(/['""`「」『』]/g, '')
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 20)
    .replace(/-$/g, '')
    .trim();

  return cleaned || topic.slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, '-');
}

// ── Discussion runner ──────────────────────────────────────────────────────

async function runDiscussion(
  d: Discussion,
  onUpdate: (msg: Record<string, unknown>) => void,
): Promise<void> {
  // 1. Prepare sub-sessions for each participant
  for (const p of d.participants) {
    if (p.reused) {
      logger.info({ sessionName: p.sessionName }, 'Reusing existing sub-session for discussion');
    } else {
      const ccSessionId = p.agentType === 'claude-code' ? crypto.randomUUID() : null;
      // Resolve a unique Gemini session ID so multiple Gemini participants don't share sessions
      let geminiSessionId: string | null = null;
      let fileSnapshot: Set<string> | undefined;
      if (p.agentType === 'gemini') {
        const { snapshotSessionFiles } = await import('./gemini-watcher.js');
        fileSnapshot = await snapshotSessionFiles();
        try {
          const { GeminiDriver } = await import('../agent/drivers/gemini.js');
          geminiSessionId = await new GeminiDriver().resolveSessionId(d.cwd || undefined);
          logger.info({ sessionName: p.sessionName, geminiSessionId }, 'Resolved Gemini session ID');
          fileSnapshot = undefined;
        } catch (e) {
          logger.warn({ err: e, sessionName: p.sessionName }, 'Failed to resolve Gemini session ID — using snapshot-diff');
        }
      }
      await startSubSession({
        id: p.subSessionId,
        type: p.agentType,
        cwd: d.cwd || null,
        ccSessionId,
        geminiSessionId,
        codexModel: p.agentType === 'codex' && p.model ? p.model : null,
        fresh: !geminiSessionId,
        _fileSnapshot: fileSnapshot,
      });
      // Sync to DB so frontend can see the sub-session
      onUpdate({
        type: 'subsession.sync',
        id: p.subSessionId,
        sessionType: p.agentType,
        cwd: d.cwd || null,
        label: `Discussion: ${p.roleLabel}`,
        ccSessionId,
      });
    }
  }

  await waitAllReady(d, 60_000);

  // Switch CC model if specified
  for (const p of d.participants) {
    if (p.agentType === 'claude-code' && p.model) {
      await sendKeysDelayedEnter(p.sessionName, `/model ${p.model}`);
      // Simple wait for model switch to take effect
      await new Promise<void>((r) => setTimeout(r, 3000));
      logger.info({ sessionName: p.sessionName, model: p.model }, 'Switched CC model');
    }
  }

  // 2. Generate semantic title via LLM, then create discussion file
  const discussDir = path.join(os.tmpdir(), 'imcodes-discussions');
  await mkdir(discussDir, { recursive: true });
  const titleAgent = d.participants[d.verdictParticipantIdx];
  const titleFile = path.join(discussDir, `title-${d.id.slice(0, 8)}.txt`);
  const title = await generateTitle(titleAgent.sessionName, d.topic, titleFile);
  d.filePath = path.join(discussDir, `${d.id.slice(0, 8)}-${title}.md`);
  await writeFile(d.filePath, buildFileHeader(d), 'utf8');
  logger.info({ discussionId: d.id, filePath: d.filePath, title }, 'Discussion file created');

  d.state = 'running';

  // Persist initial discussion state to DB
  const participantsJson = JSON.stringify(d.participants.map((p) => ({
    roleLabel: p.roleLabel, agentType: p.agentType, model: p.model,
  })));
  onUpdate({
    type: 'discussion.save',
    id: d.id, topic: d.topic, state: d.state, maxRounds: d.maxRounds,
    currentRound: 0, participants: participantsJson,
    filePath: d.filePath, startedAt: d.startedAt,
  });

  const isStopped = () => (d.state as string) === 'failed';
  const { stat } = await import('node:fs/promises');

  // 2. Multi-round discussion
  for (let round = 1; round <= d.maxRounds; round++) {
    if (isStopped()) return;
    d.currentRound = round;

    for (let i = 0; i < d.participants.length; i++) {
      if (isStopped()) return;
      const participant = d.participants[i];
      d.currentSpeakerIdx = i;
      d.updatedAt = Date.now();

      onUpdate({
        type: 'discussion.update',
        discussionId: d.id,
        state: d.state,
        currentRound: round,
        maxRounds: d.maxRounds,
        currentSpeaker: participant.roleLabel,
      });

      // Record file size before agent writes
      const sizeBefore = (await stat(d.filePath)).size;

      const modelTag = participant.model ? ` / ${participant.model}` : '';
      const sectionHeader = `### Round ${round} — ${participant.roleLabel} (${participant.agentType}${modelTag})`;
      const prompt = buildRoundPrompt(d.filePath, participant, round, d.maxRounds, sectionHeader);

      await sendKeysDelayedEnter(participant.sessionName, prompt);
      const newContent = await waitForResponse(d.filePath, sizeBefore, participant.sessionName, IDLE_TIMEOUT);

      // Extract just the response text (strip the header the agent wrote)
      const response = newContent.replace(/^###[^\n]*\n*/m, '').trim() || newContent;

      // Persist round to DB
      onUpdate({
        type: 'discussion.round_save',
        roundId: crypto.randomUUID(),
        discussionId: d.id,
        round,
        speakerRole: participant.roleLabel,
        speakerAgent: participant.agentType,
        speakerModel: participant.model,
        response,
      });
      onUpdate({
        type: 'discussion.save',
        id: d.id, topic: d.topic, state: d.state, maxRounds: d.maxRounds,
        currentRound: round, currentSpeaker: participant.roleLabel,
        participants: participantsJson, filePath: d.filePath, startedAt: d.startedAt,
      });

      onUpdate({
        type: 'discussion.update',
        discussionId: d.id,
        state: d.state,
        currentRound: round,
        maxRounds: d.maxRounds,
        currentSpeaker: participant.roleLabel,
        lastResponse: response.slice(0, 200),
      });
    }
  }

  // 3. Verdict
  d.state = 'verdict';
  const judge = d.participants[d.verdictParticipantIdx];
  const judgeModelTag = judge.model ? ` / ${judge.model}` : '';

  const verdictSizeBefore = (await stat(d.filePath)).size;
  const verdictHeader = `## Verdict (by ${judge.roleLabel}${judgeModelTag})`;
  const verdictPrompt = buildVerdictPrompt(d.filePath, judge, verdictHeader);

  await sendKeysDelayedEnter(judge.sessionName, verdictPrompt);
  const verdictContent = await waitForResponse(d.filePath, verdictSizeBefore, judge.sessionName, IDLE_TIMEOUT);
  const verdict = verdictContent.replace(/^##[^\n]*\n*/m, '').trim() || verdictContent;

  // 4. Done
  d.state = 'done';
  d.conclusion = verdict.slice(0, 500);
  d.updatedAt = Date.now();

  // Save verdict as a round
  onUpdate({
    type: 'discussion.round_save',
    roundId: crypto.randomUUID(),
    discussionId: d.id,
    round: d.maxRounds + 1,
    speakerRole: `Verdict (${judge.roleLabel})`,
    speakerAgent: judge.agentType,
    speakerModel: judge.model,
    response: verdict,
  });

  // Read final file content and persist to DB
  const fileContent = await readFile(d.filePath, 'utf8').catch(() => '');
  onUpdate({
    type: 'discussion.save',
    id: d.id, topic: d.topic, state: 'done', maxRounds: d.maxRounds,
    currentRound: d.maxRounds, participants: participantsJson,
    filePath: d.filePath, conclusion: d.conclusion, fileContent,
    startedAt: d.startedAt, finishedAt: Date.now(),
  });

  onUpdate({
    type: 'discussion.done',
    discussionId: d.id,
    filePath: d.filePath,
    conclusion: verdict.slice(0, 500),
  });

  // Only clean up newly created sessions; reused ones stay
  for (const p of d.participants) {
    if (!p.reused) {
      await stopSubSession(p.sessionName).catch(() => {});
      onUpdate({ type: 'subsession.close', id: p.subSessionId });
    }
  }

  logger.info({ discussionId: d.id, rounds: d.maxRounds }, 'Discussion completed');
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startDiscussion(
  opts: {
    id: string;
    serverId: string;
    topic: string;
    cwd: string;
    participants: Array<{
      agentType: string;
      model?: string;
      roleId: string;
      roleLabel?: string;
      rolePrompt?: string;
      sessionName?: string;
    }>;
    maxRounds?: number;
    verdictIdx?: number;
  },
  onUpdate: (msg: Record<string, unknown>) => void,
): Promise<Discussion> {
  // filePath is set later in runDiscussion after LLM generates the title
  const filePath = '';
  const participants: DiscussionParticipant[] = opts.participants.map((p, i) => {
    const reused = !!p.sessionName;
    const subId = reused
      ? p.sessionName!.replace('deck_sub_', '')
      : `discuss_${opts.id.slice(0, 6)}_${i}`;
    const builtin = BUILTIN_ROLES[p.roleId];
    return {
      subSessionId: subId,
      sessionName: reused ? p.sessionName! : `deck_sub_${subId}`,
      agentType: p.agentType as AgentType,
      model: p.model,
      roleId: p.roleId,
      roleLabel: p.roleLabel ?? builtin?.label ?? p.roleId,
      rolePrompt: p.rolePrompt ?? builtin?.prompt ?? `You are: ${p.roleId}`,
      reused,
    };
  });

  // Auto-select verdict participant: user-specified > strongest model
  let verdictIdx = opts.verdictIdx ?? -1;
  if (verdictIdx < 0 || verdictIdx >= participants.length) {
    verdictIdx = 0;
    let maxStrength = 0;
    participants.forEach((p, i) => {
      const s = participantStrength(p);
      if (s > maxStrength) {
        maxStrength = s;
        verdictIdx = i;
      }
    });
  }

  const discussion: Discussion = {
    id: opts.id,
    serverId: opts.serverId,
    topic: opts.topic,
    cwd: opts.cwd,
    state: 'setup',
    participants,
    currentRound: 0,
    maxRounds: opts.maxRounds ?? 3,
    filePath,
    currentSpeakerIdx: 0,
    verdictParticipantIdx: verdictIdx,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  discussions.set(opts.id, discussion);

  void runDiscussion(discussion, onUpdate).catch((e) => {
    discussion.state = 'failed';
    discussion.error = e instanceof Error ? e.message : String(e);
    onUpdate({ type: 'discussion.error', discussionId: discussion.id, error: discussion.error });
    onUpdate({
      type: 'discussion.save',
      id: discussion.id, topic: discussion.topic, state: 'failed', maxRounds: discussion.maxRounds,
      filePath: discussion.filePath || null, error: discussion.error,
      startedAt: discussion.startedAt, finishedAt: Date.now(),
    });
    logger.error({ err: e, discussionId: discussion.id }, 'Discussion failed');
  });

  return discussion;
}

export function getDiscussion(id: string): Discussion | undefined {
  return discussions.get(id);
}

export function listDiscussions(): Array<{
  id: string;
  topic: string;
  state: string;
  currentRound: number;
  maxRounds: number;
  currentSpeaker?: string;
  conclusion?: string;
  filePath?: string;
}> {
  return [...discussions.values()].map((d) => ({
    id: d.id,
    topic: d.topic,
    state: d.state,
    currentRound: d.currentRound,
    maxRounds: d.maxRounds,
    currentSpeaker: d.participants[d.currentSpeakerIdx]?.roleLabel,
    conclusion: d.conclusion,
    filePath: d.filePath || undefined,
  }));
}

export async function stopDiscussion(id: string): Promise<void> {
  const d = discussions.get(id);
  if (!d) return;
  d.state = 'failed';
  d.error = 'stopped by user';
  for (const p of d.participants) {
    await stopSubSession(p.sessionName).catch(() => {});
  }
}
