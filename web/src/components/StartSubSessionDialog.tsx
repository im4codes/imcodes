/**
 * StartSubSessionDialog — choose type (cc/codex/opencode/shell) and launch a sub-session.
 */
import { useState, useEffect } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';
import { FileBrowser } from './FileBrowser.js';
import { getUserPref, saveUserPref } from '../api.js';

interface Props {
  ws: WsClient | null;
  defaultCwd?: string;
  onStart: (type: string, shellBin?: string, cwd?: string, label?: string) => void;
  onClose: () => void;
}

const AGENT_TYPES = [
  { id: 'claude-code', label: 'Claude Code', icon: '⚡' },
  { id: 'codex', label: 'Codex', icon: '📦' },
  { id: 'opencode', label: 'OpenCode', icon: '🔆' },
  { id: 'gemini', label: 'Gemini CLI', icon: '♊' },
  { id: 'shell', label: 'Shell', icon: '🐚' },
  { id: 'script', label: 'Script', icon: '🔄' },
];

export function StartSubSessionDialog({ ws, defaultCwd, onStart, onClose }: Props) {
  const [type, setType] = useState('claude-code');
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>('/bin/bash');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [label, setLabel] = useState('');
  const [scriptCmd, setScriptCmd] = useState('');
  const [scriptInterval, setScriptInterval] = useState('5');
  const [detectingShells, setDetectingShells] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);

  // Load saved shell preference from server
  useEffect(() => {
    void getUserPref('default_shell').then((saved) => {
      if (typeof saved === 'string' && saved) setShellBin(saved);
    }).catch(() => {});
  }, []);

  // Request shell detection from daemon
  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'subsession.shells') {
        setShells(msg.shells);
        setDetectingShells(false);
        setShellBin((prev) => (msg.shells.includes(prev) ? prev : (msg.shells[0] ?? prev)));
      }
    });

    setDetectingShells(true);
    ws.subSessionDetectShells();
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const handleStart = () => {
    if (type === 'script') {
      if (!scriptCmd.trim()) return;
      const interval = Math.max(1, parseInt(scriptInterval, 10) || 5);
      const escaped = scriptCmd.trim().replace(/'/g, "'\\''");
      const wrapper = `bash -c 'while true; do clear; ${escaped}; sleep ${interval}; done'`;
      onStart('script', wrapper, cwd || undefined, label || scriptCmd.trim().slice(0, 30));
      return;
    }
    const selectedShell = type === 'shell' ? (shellBin || undefined) : undefined;
    if (type === 'shell' && selectedShell) {
      void saveUserPref('default_shell', selectedShell).catch(() => {});
    }
    onStart(type, selectedShell, cwd || undefined, label || undefined);
  };

  return (
    <div class="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={{ width: 380 }}>
        <div class="dialog-header">
          <span>New Sub-Session</span>
          <button class="dialog-close" onClick={onClose}>×</button>
        </div>

        <div class="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Type selection */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Type</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {AGENT_TYPES.map((at) => (
                <button
                  key={at.id}
                  class={`subsession-type-btn${type === at.id ? ' active' : ''}`}
                  onClick={() => setType(at.id)}
                >
                  <span>{at.icon}</span> {at.label}
                </button>
              ))}
            </div>
          </div>

          {/* Script command (only for script type) */}
          {type === 'script' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Command</div>
              <input
                class="input"
                placeholder="e.g. df -h, kubectl get pods, htop -t"
                value={scriptCmd}
                onInput={(e) => setScriptCmd((e.target as HTMLInputElement).value)}
                style={{ width: '100%' }}
                autoFocus
              />
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 12, marginBottom: 8 }}>Interval (seconds)</div>
              <input
                class="input"
                type="number"
                min="1"
                value={scriptInterval}
                onInput={(e) => setScriptInterval((e.target as HTMLInputElement).value)}
                style={{ width: 80 }}
              />
            </div>
          )}

          {/* Shell binary picker (only for shell type) */}
          {type === 'shell' && (
            <div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Shell</div>
              {detectingShells ? (
                <div style={{ fontSize: 12, color: '#64748b' }}>Detecting shells...</div>
              ) : shells.length > 0 ? (
                <select
                  class="input"
                  value={shellBin}
                  onChange={(e) => setShellBin((e.target as HTMLSelectElement).value)}
                  style={{ width: '100%' }}
                >
                  {shells.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <input
                  class="input"
                  placeholder="/bin/bash"
                  value={shellBin}
                  onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
                  style={{ width: '100%' }}
                />
              )}
            </div>
          )}

          {/* Working directory */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Working directory (optional)</div>
            <div class="input-with-browse">
              <input
                class="input"
                placeholder="~/projects/myapp"
                value={cwd}
                onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
              />
              {ws && (
                <button class="btn-browse" type="button" onClick={() => setShowDirBrowser(true)} title="Browse">📁</button>
              )}
            </div>
          </div>

          {showDirBrowser && ws && (
            <FileBrowser
              ws={ws}
              mode="dir-only"
              layout="modal"
              initialPath={cwd || defaultCwd || '~'}
              onConfirm={(paths) => { setCwd(paths[0] ?? ''); setShowDirBrowser(false); }}
              onClose={() => setShowDirBrowser(false)}
            />
          )}

          {/* Label */}
          <div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Label (optional)</div>
            <input
              class="input"
              placeholder="e.g. backend"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <div class="dialog-footer">
          <button class="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleStart}>Launch</button>
        </div>
      </div>
    </div>
  );
}
