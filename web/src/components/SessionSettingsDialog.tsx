/**
 * SessionSettingsDialog — edit label, description, cwd for main or sub sessions.
 */
import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { patchSession, patchSubSession } from '../api.js';
import { SESSION_AGENT_TYPES, type SessionAgentType } from '@shared/agent-types.js';

interface Props {
  serverId: string;
  /** Main session name (e.g. deck_myapp_brain) */
  sessionName: string;
  /** Sub-session ID — if set, patches sub_sessions table instead of sessions */
  subSessionId?: string;
  /** Current values */
  label: string;
  description: string;
  cwd: string;
  type: string;
  parentSession?: string | null;
  onClose: () => void;
  onSaved: (fields: { label?: string; description?: string; cwd?: string; type?: string }) => void;
}

export function SessionSettingsDialog({ serverId, sessionName, subSessionId, label: initLabel, description: initDesc, cwd: initCwd, type, parentSession, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(initLabel);
  const [description, setDescription] = useState(initDesc);
  const [cwd, setCwd] = useState(initCwd);
  const [agentType, setAgentType] = useState(type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const hasChanges = label !== initLabel || description !== initDesc || cwd !== initCwd || agentType !== type;

  const renderTypeLabel = (value: string): string => {
    switch (value) {
      case 'claude-code-sdk': return t('session.agentType.claude_code_sdk');
      case 'claude-code': return t('session.agentType.claude_code_cli');
      case 'codex-sdk': return t('session.agentType.codex_sdk');
      case 'codex': return t('session.agentType.codex_cli');
      case 'qwen': return t('session.agentType.qwen');
      case 'openclaw': return t('session.agentType.openclaw');
      default: return value;
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const fields: { label?: string | null; description?: string | null; cwd?: string | null; agentType?: string | null; type?: string | null } = {};
      if (label !== initLabel) fields.label = label || null;
      if (description !== initDesc) fields.description = description || null;
      if (cwd !== initCwd) fields.cwd = cwd || null;
      if (agentType !== type) {
        if (subSessionId) fields.type = agentType;
        else fields.agentType = agentType;
      }

      if (subSessionId) {
        await patchSubSession(serverId, subSessionId, fields);
      } else {
        await patchSession(serverId, sessionName, fields);
      }
      onSaved({ label: label || undefined, description: description || undefined, cwd: cwd || undefined, type: agentType || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 400 }}>
        <div class="dialog-header">
          <span>{t('session.settings')}</span>
          <button class="dialog-close" onClick={onClose}>×</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Type */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.type')}</div>
            <select
              class="input"
              value={agentType}
              onChange={(e) => setAgentType((e.target as HTMLSelectElement).value as SessionAgentType)}
              style={{ width: '100%' }}
              disabled={saving}
            >
              {SESSION_AGENT_TYPES.map((value) => (
                <option key={value} value={value}>{renderTypeLabel(value)}</option>
              ))}
            </select>
          </div>

          {/* Parent session (read-only, sub-session only) */}
          {parentSession && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.parentSession')}</div>
              <div style={{ fontSize: 13, color: '#64748b' }}>{parentSession}</div>
            </div>
          )}

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.label')}</div>
            <input
              class="input"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
              disabled={saving}
            />
          </div>

          {/* Description */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.description')}</div>
            <textarea
              class="input"
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={3}
              style={{ width: '100%', resize: 'vertical' }}
              disabled={saving}
              placeholder={t('session.descriptionPlaceholder')}
            />
          </div>

          {/* Working directory */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{t('session.workingDir')}</div>
            <input
              class="input"
              value={cwd}
              onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
              disabled={saving}
              placeholder="~/projects/myapp"
            />
          </div>

          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}
        </div>

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button class="btn btn-primary" onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? '...' : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
