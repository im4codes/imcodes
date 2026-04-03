import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import { saveUserPref } from '../api.js';

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', models: ['opus[1M]', 'sonnet'] },
  { id: 'codex', label: 'Codex', models: [] },
  { id: 'gemini', label: 'Gemini', models: [] },
];

interface Participant {
  roleId: string;
  customRoleLabel?: string;
  customRolePrompt?: string;
  agentType: string;
  model?: string;
  sessionName?: string;
}

export interface SubSessionOption {
  sessionName: string;
  label: string;
  type: string;
}

export interface DiscussionPrefs {
  participants: Participant[];
  verdictIdx: number;
  maxRounds: number;
}

interface Props {
  ws: WsClient;
  defaultCwd?: string;
  existingSessions: SubSessionOption[];
  savedPrefs?: DiscussionPrefs | null;
  onClose: () => void;
}

export function StartDiscussionDialog({ ws, defaultCwd, existingSessions, savedPrefs, onClose }: Props) {
  const { t } = useTranslation();

  const PRESET_ROLES = [
    { id: 'critic', label: t('discussion.role_critic'), icon: '🔍' },
    { id: 'pragmatist', label: t('discussion.role_pragmatist'), icon: '🔧' },
    { id: 'innovator', label: t('discussion.role_innovator'), icon: '💡' },
    { id: 'custom', label: t('discussion.role_custom'), icon: '✏️' },
  ];

  const [topic, setTopic] = useState('');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [participants, setParticipants] = useState<Participant[]>(
    savedPrefs?.participants ?? [
      { roleId: 'critic', agentType: 'claude-code', model: 'opus[1M]' },
      { roleId: 'pragmatist', agentType: 'claude-code', model: 'sonnet' },
    ],
  );
  const [verdictIdx, setVerdictIdx] = useState(savedPrefs?.verdictIdx ?? 0);
  const [maxRounds, setMaxRounds] = useState(savedPrefs?.maxRounds ?? 3);

  const addParticipant = () => {
    if (participants.length >= 3) return;
    const usedRoles = new Set(participants.map((p) => p.roleId));
    const nextRole = PRESET_ROLES.find((r) => !usedRoles.has(r.id) && r.id !== 'custom')?.id ?? 'critic';
    setParticipants([...participants, { roleId: nextRole, agentType: 'claude-code', model: 'sonnet' }]);
  };

  const removeParticipant = (idx: number) => {
    if (participants.length <= 2) return;
    const next = participants.filter((_, i) => i !== idx);
    setParticipants(next);
    if (verdictIdx >= next.length) setVerdictIdx(next.length - 1);
  };

  const updateParticipant = (idx: number, updates: Partial<Participant>) => {
    setParticipants(participants.map((p, i) => (i === idx ? { ...p, ...updates } : p)));
  };

  const handleStart = () => {
    if (!topic.trim()) return;
    void saveUserPref('discussion_prefs', {
      participants: participants.map((p) => ({
        roleId: p.roleId,
        customRoleLabel: p.customRoleLabel,
        customRolePrompt: p.customRolePrompt,
        agentType: p.agentType,
        model: p.model,
      })),
      verdictIdx,
      maxRounds,
    });
    ws.discussionStart(
      topic,
      cwd,
      participants.map((p) => ({
        agentType: p.agentType,
        model: p.model,
        roleId: p.roleId,
        roleLabel: p.roleId === 'custom' ? p.customRoleLabel : undefined,
        rolePrompt: p.roleId === 'custom' ? p.customRolePrompt : undefined,
        sessionName: p.sessionName,
      })),
      maxRounds,
      verdictIdx,
    );
    onClose();
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 520 }}>
        <div class="dialog-header">
          <span>Start Discussion</span>
          <button class="dialog-close" onClick={onClose}>✕</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Topic */}
          <div>
            <div class="field-label">Topic</div>
            <textarea
              class="input"
              rows={3}
              placeholder="Describe what you want the agents to discuss..."
              value={topic}
              onInput={(e) => setTopic((e.target as HTMLTextAreaElement).value)}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          {/* Working directory */}
          <div>
            <div class="field-label">Working Directory</div>
            <input
              class="input"
              placeholder="~/projects/myapp"
              value={cwd}
              onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>

          {/* Participants */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div class="field-label" style={{ margin: 0 }}>Participants</div>
              {participants.length < 3 && (
                <button class="btn btn-sm" onClick={addParticipant}>+ Add</button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {participants.map((p, idx) => (
                <div key={idx} class="discussion-participant-row">
                  {/* Verdict selector */}
                  <button
                    type="button"
                    class={`btn btn-sm${verdictIdx === idx ? ' btn-primary' : ''}`}
                    onClick={() => setVerdictIdx(idx)}
                    style={{ whiteSpace: 'nowrap', minWidth: 60, fontSize: 12 }}
                  >
                    {verdictIdx === idx ? t('discussion.arbiter_active') : t('discussion.arbiter')}
                  </button>

                  {/* Role selector */}
                  <select
                    class="input input-sm"
                    value={p.roleId}
                    onChange={(e) => updateParticipant(idx, { roleId: (e.target as HTMLSelectElement).value })}
                  >
                    {PRESET_ROLES.map((r) => (
                      <option key={r.id} value={r.id}>{r.icon} {r.label}</option>
                    ))}
                  </select>

                  {/* Custom role inputs */}
                  {p.roleId === 'custom' && (
                    <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                      <input
                        class="input input-sm"
                        placeholder="Role name"
                        value={p.customRoleLabel ?? ''}
                        onInput={(e) => updateParticipant(idx, { customRoleLabel: (e.target as HTMLInputElement).value })}
                        style={{ flex: '0 0 100px' }}
                      />
                      <input
                        class="input input-sm"
                        placeholder="Role prompt"
                        value={p.customRolePrompt ?? ''}
                        onInput={(e) => updateParticipant(idx, { customRolePrompt: (e.target as HTMLInputElement).value })}
                        style={{ flex: 1 }}
                      />
                    </div>
                  )}

                  {/* Session source: new or reuse */}
                  {p.roleId !== 'custom' && (
                    <select
                      class="input input-sm"
                      value={p.sessionName ?? '_new'}
                      onChange={(e) => {
                        const val = (e.target as HTMLSelectElement).value;
                        if (val === '_new') {
                          updateParticipant(idx, { sessionName: undefined });
                        } else {
                          const existing = existingSessions.find((s) => s.sessionName === val);
                          updateParticipant(idx, {
                            sessionName: val,
                            agentType: existing?.type ?? p.agentType,
                          });
                        }
                      }}
                    >
                      <option value="_new">{t('session.new_btn')}</option>
                      {existingSessions.map((s) => (
                        <option key={s.sessionName} value={s.sessionName}>
                          {s.label || s.sessionName} ({s.type})
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Agent + Model (new sessions only) */}
                  {!p.sessionName && p.roleId !== 'custom' && (
                    <>
                      <select
                        class="input input-sm"
                        value={p.agentType}
                        onChange={(e) => {
                          const agent = (e.target as HTMLSelectElement).value;
                          updateParticipant(idx, {
                            agentType: agent,
                            model: agent === 'claude-code' ? 'sonnet' : undefined,
                          });
                        }}
                      >
                        {AGENTS.map((a) => (
                          <option key={a.id} value={a.id}>{a.label}</option>
                        ))}
                      </select>

                      {p.agentType === 'claude-code' && (
                        <select
                          class="input input-sm"
                          value={p.model ?? 'sonnet'}
                          onChange={(e) => updateParticipant(idx, { model: (e.target as HTMLSelectElement).value })}
                        >
                          <option value="opus[1M]">Opus [1M]</option>
                          <option value="sonnet">Sonnet</option>
                        </select>
                      )}
                    </>
                  )}

                  {/* Remove button */}
                  {participants.length > 2 && (
                    <button class="btn btn-sm btn-danger" onClick={() => removeParticipant(idx)}>✕</button>
                  )}

                </div>
              ))}
            </div>
          </div>

          {/* Max Rounds */}
          <div>
            <div class="field-label">Max Rounds</div>
            <select
              class="input"
              value={maxRounds}
              onChange={(e) => setMaxRounds(Number((e.target as HTMLSelectElement).value))}
              style={{ width: 80 }}
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
            </select>
          </div>
        </div>

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart} disabled={!topic.trim()}>
            Start Discussion
          </button>
        </div>
      </div>
    </div>
  );
}
