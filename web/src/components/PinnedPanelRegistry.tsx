/**
 * PinnedPanelRegistry — generic registry for pinnable panel types.
 *
 * Each panel type registers:
 *   - title: how to derive the panel header title
 *   - render: how to render the panel content given stored props + runtime context
 *
 * To add a new pinnable window type:
 *   1. Register it here with a unique type key
 *   2. Pass `onPin` to its FloatingPanel with the correct type + props
 *   That's it — no other files need changing.
 */
import type { ComponentChildren } from 'preact';
import type { TFunction } from 'i18next';
import type { WsClient } from '../ws-client.js';
import type { PinnedPanel } from '../app.js';
import type { SubSession } from '../hooks/useSubSessions.js';

export interface PanelRenderContext {
  ws: WsClient | null;
  connected: boolean;
  serverId: string;
  /** All live sub-sessions — for sub-session panel type */
  subSessions: SubSession[];
  /** Input refs map for file insertion */
  inputRefsMap?: { current: Map<string, HTMLElement> };
  /** For repo/file browser CI events */
  onCiEvent?: (run: { name: string; status: string; conclusion?: string | null }) => void;
  /** Open a file preview in a large floating window (used by pinned file browser) */
  onPreviewFile?: (request: { path: string; preferDiff?: boolean }) => void;
  /** Current active session name — for file browser to follow tab switches */
  activeSession?: string | null;
  /** Current active session's project directory — follows tab switches */
  activeProjectDir?: string;
  /** Quote callback — adds quoted text to the main session's input */
  onQuote?: (text: string) => void;
  /** Main sessions list — for panels that need session info (e.g., cron manager) */
  sessions?: Array<{ name: string; project: string; role: string; agentType: string; label?: string | null; state: string; runtimeType?: string }>;
  /** All servers — for cron manager cross-server view */
  servers?: Array<{ id: string; name: string }>;
  /** Translation function for panel headers and status copy. */
  t: TFunction;
  /** Persist declarative pinned-panel props updates. */
  updatePanelProps?: (panelId: string, props: Record<string, unknown>) => void;
}

export interface PanelTypeRegistration {
  title: (panel: PinnedPanel, ctx?: PanelRenderContext) => string;
  render: (panel: PinnedPanel, ctx: PanelRenderContext) => ComponentChildren;
}

const registry = new Map<string, PanelTypeRegistration>();

export function registerPanelType(type: string, reg: PanelTypeRegistration): void {
  registry.set(type, reg);
}

export function getPanelType(type: string): PanelTypeRegistration | undefined {
  return registry.get(type);
}

export function getPanelTitle(panel: PinnedPanel, ctx?: PanelRenderContext): string {
  const reg = registry.get(panel.type);
  return reg ? reg.title(panel, ctx) : panel.type;
}

export function renderPanelContent(panel: PinnedPanel, ctx: PanelRenderContext): ComponentChildren {
  const reg = registry.get(panel.type);
  if (!reg) return null;
  return reg.render(panel, ctx);
}
