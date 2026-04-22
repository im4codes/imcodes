import { useState, useEffect, useMemo } from "preact/hooks";
import { useTranslation } from "react-i18next";
import type { WsClient } from "../ws-client.js";
import { FileBrowser } from "./file-browser-lazy.js";
import { getUserPref, saveUserPref } from "../api.js";
import { sanitizeProjectName } from "@shared/sanitize-project-name.js";
import {
  getSessionAgentGroups,
  getSessionAgentLabel,
  SESSION_AGENT_GROUP_LABEL_KEYS,
} from "./session-agent-options.js";
import {
  CLAUDE_SDK_EFFORT_LEVELS,
  CODEX_SDK_EFFORT_LEVELS,
  COPILOT_SDK_EFFORT_LEVELS,
  OPENCLAW_THINKING_LEVELS,
  QWEN_EFFORT_LEVELS,
  type TransportEffortLevel,
} from "@shared/effort-levels.js";
import {
  useTransportModels,
  supportsDynamicTransportModels,
} from "../hooks/useTransportModels.js";
import { QwenCodingPlanHint } from "./QwenCodingPlanHint.js";
import {
  buildCcPresetFromDraft,
  createCcPresetDraftFromPreset,
  createDefaultCcPresetDraft,
  type CcPresetDraft,
  type CcPresetEntry,
} from "./cc-preset-form.js";
import { CC_PRESET_MSG } from "@shared/cc-presets.js";
import type { CcPreset } from "@shared/cc-presets.js";

const DEFAULT_SHELL_KEY = "default_shell";
// Fallback suggestions used only when the daemon probe returns an empty list
// (offline/unauthenticated). The live list comes from the dynamic models hook.
const CURSOR_HEADLESS_MODEL_FALLBACK = ["auto", "composer-2-fast", "gpt-5.2"] as const;
const COPILOT_SDK_MODEL_FALLBACK = ["gpt-5", "claude-sonnet-4.5"] as const;

interface Props {
  ws: WsClient | null;
  onClose: () => void;
  onSessionStarted: (sessionName: string) => void;
  isProviderConnected: (id: string) => boolean;
}

type AgentType =
  | "claude-code"
  | "claude-code-sdk"
  | "codex"
  | "codex-sdk"
  | "copilot-sdk"
  | "cursor-headless"
  | "opencode"
  | "gemini"
  | "openclaw"
  | "qwen";
type OpenClawMode = "new" | "bind";

interface RemoteSession {
  id: string;
  label: string;
}

export function NewSessionDialog({
  ws,
  onClose,
  onSessionStarted,
  isProviderConnected: _isProviderConnected,
}: Props) {
  const { t } = useTranslation();
  const [project, setProject] = useState("");
  const [dir, setDir] = useState("~/");
  const [agentType, setAgentType] = useState<AgentType>("claude-code-sdk");
  const [requestedModel, setRequestedModel] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [thinking, setThinking] = useState<TransportEffortLevel>("high");
  const [shells, setShells] = useState<string[]>([]);
  const [shellBin, setShellBin] = useState<string>("");
  const agentGroups = getSessionAgentGroups("new-session");

  // CC env presets
  const [ccPresets, setCcPresets] = useState<CcPresetEntry[]>([]);
  const [ccPreset, setCcPreset] = useState<string>("");
  const [ccInitPrompt, setCcInitPrompt] = useState<string>("");
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  // New preset form
  const defaultPresetDraft = createDefaultCcPresetDraft();
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetBaseUrl, setNewPresetBaseUrl] = useState(defaultPresetDraft.baseUrl);
  const [newPresetToken, setNewPresetToken] = useState("");
  const [newPresetModel, setNewPresetModel] = useState(defaultPresetDraft.model);
  const [newPresetCtx, setNewPresetCtx] = useState(defaultPresetDraft.contextWindow);
  const [newPresetCustomEnv, setNewPresetCustomEnv] = useState<
    Array<{ key: string; value: string }>
  >(defaultPresetDraft.customEnv);
  const [newPresetInit, setNewPresetInit] = useState(defaultPresetDraft.initMessage);
  const [newPresetAvailableModels, setNewPresetAvailableModels] = useState(
    defaultPresetDraft.availableModels,
  );
  const [presetError, setPresetError] = useState("");
  const [discoveringPreset, setDiscoveringPreset] = useState(false);
  const fmtCtx = (v: string) => {
    const n = parseInt(v, 10);
    if (!n) return "";
    if (n >= 1000000)
      return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return String(n);
  };
  const applyPresetDraft = (draft: CcPresetDraft) => {
    setNewPresetName(draft.name);
    setNewPresetBaseUrl(draft.baseUrl);
    setNewPresetToken(draft.token);
    setNewPresetModel(draft.model);
    setNewPresetCtx(draft.contextWindow);
    setNewPresetCustomEnv(draft.customEnv);
    setNewPresetInit(draft.initMessage);
    setNewPresetAvailableModels(draft.availableModels);
  };
  const buildCurrentPresetDraft = (): CcPresetDraft => ({
    name: newPresetName,
    baseUrl: newPresetBaseUrl,
    token: newPresetToken,
    model: newPresetModel,
    contextWindow: newPresetCtx,
    customEnv: newPresetCustomEnv,
    initMessage: newPresetInit,
    availableModels: newPresetAvailableModels,
  });
  const persistPresetDraft = (): CcPresetEntry => {
    const preset = buildCcPresetFromDraft(buildCurrentPresetDraft());
    const updated = [...ccPresets.filter((p) => p.name !== preset.name), preset];
    setCcPresets(updated);
    try {
      ws?.send({ type: CC_PRESET_MSG.SAVE, presets: updated });
    } catch {}
    return preset;
  };
  const selectedCcPreset = useMemo(
    () => ccPresets.find((preset) => preset.name === ccPreset),
    [ccPreset, ccPresets],
  );
  const qwenPresetModels = useMemo(
    () => selectedCcPreset?.availableModels?.map((item) => item.id) ?? [],
    [selectedCcPreset],
  );

  // OpenClaw-specific state
  const [ocMode, setOcMode] = useState<OpenClawMode>("new");
  const [ocSessionKey, setOcSessionKey] = useState("");
  const [ocDescription, setOcDescription] = useState("");
  const [ocRemoteSessions, setOcRemoteSessions] = useState<RemoteSession[]>([]);
  const [ocLoadingSessions, setOcLoadingSessions] = useState(false);
  const [ocSelectedSession, setOcSelectedSession] = useState("");

  // Load saved shell preference — will be validated against daemon's detected list later
  const [savedShellPref, setSavedShellPref] = useState<string | null>(null);
  useEffect(() => {
    void getUserPref(DEFAULT_SHELL_KEY)
      .then((saved) => {
        if (typeof saved === "string" && saved) setSavedShellPref(saved);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === "subsession.shells") {
        const list = msg.shells as string[];
        setShells(list);
        // Use saved preference only if daemon actually has that shell; otherwise pick first detected
        const preferred = savedShellPref;
        if (preferred && list.includes(preferred)) {
          setShellBin(preferred);
        } else {
          setShellBin(list[0] ?? "");
        }
      }
      // Listen for CC presets response
      if (msg.type === CC_PRESET_MSG.LIST_RESPONSE) {
        setCcPresets((msg as any).presets ?? []);
      }
      if (msg.type === CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE) {
        setDiscoveringPreset(false);
        if (msg.preset) {
          setCcPresets((current) => [
            ...current.filter((preset) => preset.name !== msg.preset?.name),
            msg.preset,
          ].filter((preset): preset is CcPreset => preset !== undefined));
          if (newPresetName.trim().toLowerCase() === msg.preset.name.trim().toLowerCase()) {
            applyPresetDraft(createCcPresetDraftFromPreset(msg.preset));
          }
          if (ccPreset === msg.preset.name || !ccPreset) setCcPreset(msg.preset.name);
          const nextModel = msg.preset.defaultModel
            ?? msg.preset.availableModels?.[0]?.id
            ?? msg.preset.env.ANTHROPIC_MODEL;
          if (nextModel) setRequestedModel(nextModel);
        }
        setPresetError(msg.ok ? "" : (msg.error ?? "Failed to discover models"));
      }
      // Listen for openclaw remote session list response
      const raw = msg as unknown as Record<string, unknown>;
      if (raw["type"] === "openclaw.sessions_response") {
        const sessions = raw["sessions"] as RemoteSession[] | undefined;
        setOcRemoteSessions(sessions ?? []);
        setOcLoadingSessions(false);
      }
    });
    ws.subSessionDetectShells?.();
    try {
      ws.send({ type: CC_PRESET_MSG.LIST });
    } catch {
      /* ws may not support send in test */
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Fetch remote sessions when bind mode is selected
  useEffect(() => {
    if (agentType !== "openclaw" || ocMode !== "bind" || !ws) return;
    setOcLoadingSessions(true);
    setOcRemoteSessions([]);
    ws.send({ type: "openclaw.list_sessions" });
  }, [agentType, ocMode, ws]);

  // Auto-generate a session key when switching to openclaw new mode
  useEffect(() => {
    if (agentType === "openclaw" && ocMode === "new" && !ocSessionKey) {
      setOcSessionKey(`oc-${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [agentType, ocMode, ocSessionKey]);

  // (openclaw fallback removed — show connect hint instead of auto-switching)

  // Listen for session.event started/error while dialog is open
  useEffect(() => {
    if (!ws || !starting) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === "session.event") {
        const name = msg.session ?? "";
        const slug = sanitizeProjectName(project);
        if (msg.event === "started" && name.startsWith(`deck_${slug}_`)) {
          unsub();
          onSessionStarted(name);
          onClose();
        } else if (msg.event === "error" && name.startsWith(`deck_${slug}_`)) {
          unsub();
          setError(`Session failed to start: ${msg.state}`);
          setStarting(false);
        }
      }
      if (msg.type === "session.error") {
        unsub();
        setError(
          (msg as unknown as { message: string }).message ||
            "Failed to start session",
        );
        setStarting(false);
      }
    });

    // Timeout after 15s
    const timeout = setTimeout(() => {
      unsub();
      setError(t("new_session.timeout"));
      setStarting(false);
    }, 15_000);

    return () => {
      unsub();
      clearTimeout(timeout);
    };
  }, [starting, ws, project]);

  const handleStart = () => {
    if (!project.trim()) {
      setError(t("new_session.project_required"));
      return;
    }
    if (!dir.trim()) {
      setError(t("new_session.dir_required"));
      return;
    }
    if (!ws) {
      setError(t("new_session.not_connected"));
      return;
    }
    if (!ws.connected) {
      setError(t("new_session.daemon_offline"));
      return;
    }

    setError("");
    setStarting(true);
    if (shellBin)
      void saveUserPref(DEFAULT_SHELL_KEY, shellBin).catch(() => {});

    if (agentType === "openclaw") {
      const extra =
        ocMode === "bind"
          ? { ocMode: "bind", ocSessionId: ocSelectedSession }
          : {
              ocMode: "new",
              ocSessionKey: ocSessionKey.trim(),
              ocDescription: ocDescription.trim(),
            };
      ws.sendSessionCommand("start", {
        project: project.trim(),
        dir: dir.trim(),
        agentType,
        ...extra,
        thinking,
      });
    } else {
      const extra: Record<string, unknown> = {};
      if (ccPreset && (agentType === "claude-code" || agentType === "qwen"))
        extra.ccPreset = ccPreset;
      if (ccInitPrompt.trim() && agentType === "claude-code")
        extra.ccInitPrompt = ccInitPrompt.trim();
      if (
        (agentType === "copilot-sdk"
          || agentType === "cursor-headless"
          || agentType === "qwen") &&
        requestedModel.trim()
      ) {
        extra.requestedModel = requestedModel.trim();
      }
      ws.sendSessionCommand("start", {
        project: project.trim(),
        dir: dir.trim(),
        agentType,
        ...extra,
        ...(agentType === "claude-code-sdk" ||
        agentType === "codex-sdk" ||
        agentType === "copilot-sdk" ||
        agentType === "qwen"
          ? { thinking }
          : {}),
      });
    }
  };

  const agentFlavor =
    agentType === "claude-code" || agentType === "codex"
      ? "cli"
      : agentType === "claude-code-sdk" || agentType === "codex-sdk"
        ? "sdk"
        : null;
  const thinkingLevels =
    agentType === "claude-code-sdk"
      ? CLAUDE_SDK_EFFORT_LEVELS
      : agentType === "codex-sdk"
        ? CODEX_SDK_EFFORT_LEVELS
        : agentType === "copilot-sdk"
          ? COPILOT_SDK_EFFORT_LEVELS
          : agentType === "qwen"
            ? QWEN_EFFORT_LEVELS
            : agentType === "openclaw"
              ? OPENCLAW_THINKING_LEVELS
              : [];
  const supportsCcPreset = agentType === "claude-code" || agentType === "qwen";
  const supportsModelSelection =
    agentType === "copilot-sdk"
    || agentType === "cursor-headless"
    || (agentType === "qwen" && !!selectedCcPreset);
  const dynamicModelsAgentType = supportsDynamicTransportModels(agentType)
    ? agentType
    : null;
  const transportModels = useTransportModels(ws, dynamicModelsAgentType);
  const modelSuggestions = useMemo(() => {
    if (transportModels.models.length > 0) {
      return transportModels.models.map((m) => m.id);
    }
    if (agentType === "qwen") {
      return qwenPresetModels.length > 0
        ? qwenPresetModels
        : (selectedCcPreset?.defaultModel ? [selectedCcPreset.defaultModel] : []);
    }
    if (agentType === "copilot-sdk") return [...COPILOT_SDK_MODEL_FALLBACK];
    if (agentType === "cursor-headless") return [...CURSOR_HEADLESS_MODEL_FALLBACK];
    return [] as string[];
  }, [transportModels.models, agentType, qwenPresetModels, selectedCcPreset]);

  useEffect(() => {
    setThinking("high");
  }, [agentType]);

  useEffect(() => {
    if (agentType !== "qwen") return;
    const fallbackModel =
      selectedCcPreset?.defaultModel ?? selectedCcPreset?.env.ANTHROPIC_MODEL ?? "";
    if (modelSuggestions.length === 0) {
      if (!requestedModel && fallbackModel) setRequestedModel(fallbackModel);
      return;
    }
    if (!requestedModel || !modelSuggestions.includes(requestedModel)) {
      setRequestedModel(
        modelSuggestions.includes(fallbackModel) ? fallbackModel : modelSuggestions[0],
      );
    }
  }, [agentType, modelSuggestions, requestedModel, selectedCcPreset]);

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !starting) handleStart();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#00000080",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onKeyDown={handleKey}
      role="dialog"
    >
      <div
        style={{
          background: "#1e293b",
          border: "1px solid #334155",
          borderRadius: 8,
          padding: 24,
          width: 400,
        }}
      >
        <h2 style={{ margin: "0 0 20px", fontSize: 16, color: "#f1f5f9" }}>
          {t("new_session.title")}
        </h2>

        <div class="form-group">
          <label>{t("new_session.project_name")}</label>
          <input
            type="text"
            placeholder="my-project"
            value={project}
            disabled={starting}
            onInput={(e) => {
              setProject((e.target as HTMLInputElement).value);
              setError("");
            }}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellcheck={false}
            data-lpignore="true"
            data-1p-ignore
          />
        </div>

        <div class="form-group">
          <label>{t("new_session.working_directory")}</label>
          <div class="input-with-browse">
            <input
              type="text"
              placeholder="~/projects/my-project"
              value={dir}
              disabled={starting}
              onInput={(e) => setDir((e.target as HTMLInputElement).value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellcheck={false}
              data-lpignore="true"
              data-1p-ignore
            />
            {ws && (
              <button
                class="btn-browse"
                type="button"
                disabled={starting}
                onClick={() => setShowDirBrowser(true)}
                title={t("new_session.browse")}
              >
                📁
              </button>
            )}
          </div>
        </div>

        {showDirBrowser && ws && (
          <FileBrowser
            ws={ws}
            mode="dir-only"
            layout="modal"
            initialPath={dir || "~"}
            onConfirm={(paths) => {
              setDir(paths[0] ?? "");
              setShowDirBrowser(false);
            }}
            onClose={() => setShowDirBrowser(false)}
          />
        )}

        <div class="form-group">
          <label>{t("new_session.agent_type")}</label>
          <select
            value={agentType}
            disabled={starting}
            onInput={(e) =>
              setAgentType((e.target as HTMLSelectElement).value as AgentType)
            }
            style={{
              width: "100%",
              background: "#0f172a",
              border: "1px solid #334155",
              color: "#e2e8f0",
              padding: "8px 12px",
              borderRadius: 4,
              fontFamily: "inherit",
            }}
          >
            {agentGroups.map((group) => (
              <optgroup key={group.id} label={t(SESSION_AGENT_GROUP_LABEL_KEYS[group.id])}>
                {group.items.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {getSessionAgentLabel(t, choice)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {agentFlavor && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "#94a3b8",
                lineHeight: 1.4,
              }}
            >
              {agentFlavor === "cli"
                ? t("new_session.agent_flavor_cli")
                : t("new_session.agent_flavor_sdk")}
            </div>
          )}
          <QwenCodingPlanHint selected={agentType === "qwen"} />
        </div>

        {thinkingLevels.length > 0 && (
          <div class="form-group">
            <label>{t("session.thinking")}</label>
            <select
              value={thinking}
              disabled={starting}
              onInput={(e) =>
                setThinking(
                  (e.target as HTMLSelectElement).value as TransportEffortLevel,
                )
              }
              style={{
                width: "100%",
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#e2e8f0",
                padding: "8px 12px",
                borderRadius: 4,
                fontFamily: "inherit",
              }}
            >
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>
        )}

        {supportsModelSelection && (
          <div class="form-group">
            <label>{t("session.supervision.model")}</label>
            {agentType === "qwen" && modelSuggestions.length > 0 ? (
              <select
                value={requestedModel}
                disabled={starting}
                onInput={(e) =>
                  setRequestedModel((e.target as HTMLSelectElement).value)
                }
              >
                {modelSuggestions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                list={`new-session-model-options-${agentType}`}
                placeholder={t("session.supervision.selectModel")}
                value={requestedModel}
                disabled={starting}
                onInput={(e) =>
                  setRequestedModel((e.target as HTMLInputElement).value)
                }
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellcheck={false}
                data-lpignore="true"
                data-1p-ignore
              />
            )}
            {modelSuggestions.length > 0 && (
              <datalist id={`new-session-model-options-${agentType}`}>
                {modelSuggestions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            )}
          </div>
        )}

        {/* CC env preset selector + editor */}
        {supportsCcPreset && (
          <>
            <div class="form-group">
              <label
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>{agentType === "qwen" ? "Compatible API (via Qwen)" : t("new_session.api_provider")}</span>
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#3b82f6",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: 0,
                  }}
                  onClick={() => setShowPresetEditor(!showPresetEditor)}
                >
                  {showPresetEditor
                    ? `▾ ${t("common.close")}`
                    : t("new_session.api_provider_add_edit")}
                </button>
              </label>
              {ccPresets.length > 0 && (
                <select
                  value={ccPreset}
                  disabled={starting}
                  onInput={(e) =>
                    setCcPreset((e.target as HTMLSelectElement).value)
                  }
                  style={{
                    width: "100%",
                    background: "#0f172a",
                    border: "1px solid #334155",
                    color: "#e2e8f0",
                    padding: "8px 12px",
                    borderRadius: 4,
                    fontFamily: "inherit",
                  }}
                >
                  <option value="">
                    {t("new_session.api_provider_default")}
                  </option>
                  {ccPresets.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {(p.defaultModel ?? p.env["ANTHROPIC_MODEL"])
                        ? ` (${p.defaultModel ?? p.env["ANTHROPIC_MODEL"]})`
                        : ""}
                    </option>
                  ))}
                </select>
              )}
              {ccPresets.length === 0 && !showPresetEditor && (
                <div
                  style={{ fontSize: 12, color: "#475569", padding: "4px 0" }}
                >
                  {t("new_session.api_provider_default_help")}
                </div>
              )}
            </div>

            {/* Inline preset editor */}
            {showPresetEditor && (
              <div
                style={{
                  background: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 12,
                  fontSize: 12,
                }}
              >
                <div
                  style={{ marginBottom: 4, fontWeight: 600, color: "#94a3b8" }}
                >
                  Add / Edit Preset
                </div>
                <div
                  style={{ fontSize: 10, color: "#475569", marginBottom: 8 }}
                >
                  Stored locally on daemon (~/.imcodes/cc-presets.json)
                </div>
                {[
                  {
                    label: "Preset Name",
                    envKey: "",
                    ph: "e.g. MiniMax",
                    val: newPresetName,
                    set: setNewPresetName,
                  },
                  {
                    label: "API Base URL",
                    envKey: "ANTHROPIC_BASE_URL",
                    ph: "https://api.minimax.io/anthropic",
                    val: newPresetBaseUrl,
                    set: setNewPresetBaseUrl,
                  },
                  {
                    label: "API Key",
                    envKey: "ANTHROPIC_AUTH_TOKEN",
                    ph: "your-api-key",
                    val: newPresetToken,
                    set: setNewPresetToken,
                    type: "password" as const,
                  },
                  {
                    label: "Model",
                    envKey: "ANTHROPIC_MODEL",
                    ph: "e.g. MiniMax-M2.7",
                    val: newPresetModel,
                    set: setNewPresetModel,
                  },
                ].map(({ label, envKey, ph, val, set, type }) => (
                  <div key={label} style={{ marginBottom: 5 }}>
                    <div
                      style={{
                        fontSize: 10,
                        color: "#64748b",
                        marginBottom: 2,
                      }}
                    >
                      {label}
                      {envKey && (
                        <span style={{ color: "#334155", marginLeft: 4 }}>
                          {envKey}
                        </span>
                      )}
                    </div>
                    <input
                      type={type ?? "text"}
                      placeholder={ph}
                      value={val}
                      onInput={(e) => set((e.target as HTMLInputElement).value)}
                      style={{
                        width: "100%",
                        background: "#1e293b",
                        border: "1px solid #334155",
                        color: "#e2e8f0",
                        padding: "5px 8px",
                        borderRadius: 4,
                        fontSize: 12,
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                ))}
                {newPresetAvailableModels.length > 0 && (
                  <div style={{ marginBottom: 5 }}>
                    <div
                      style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}
                    >
                      Discovered Models
                    </div>
                    <select
                      value={newPresetModel}
                      onInput={(e) =>
                        setNewPresetModel((e.target as HTMLSelectElement).value)
                      }
                      style={{
                        width: "100%",
                        background: "#1e293b",
                        border: "1px solid #334155",
                        color: "#e2e8f0",
                        padding: "5px 8px",
                        borderRadius: 4,
                        fontSize: 12,
                        boxSizing: "border-box",
                      }}
                    >
                      {newPresetAvailableModels.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name ? `${item.name} (${item.id})` : item.id}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ marginBottom: 5 }}>
                  <div
                    style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}
                  >
                    Context Window
                    {newPresetCtx && (
                      <span style={{ color: "#3b82f6", marginLeft: 6 }}>
                        {fmtCtx(newPresetCtx)}
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    placeholder="1000000"
                    value={newPresetCtx}
                    onInput={(e) =>
                      setNewPresetCtx((e.target as HTMLInputElement).value)
                    }
                    style={{
                      width: "100%",
                      background: "#1e293b",
                      border: "1px solid #334155",
                      color: "#e2e8f0",
                      padding: "5px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                {/* Custom env vars */}
                <div style={{ marginBottom: 5 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontSize: 10, color: "#64748b" }}>
                      Custom ENV Vars
                    </span>
                    <button
                      type="button"
                      style={{
                        background: "none",
                        border: "none",
                        color: "#3b82f6",
                        cursor: "pointer",
                        fontSize: 10,
                        padding: 0,
                      }}
                      onClick={() =>
                        setNewPresetCustomEnv([
                          ...newPresetCustomEnv,
                          { key: "", value: "" },
                        ])
                      }
                    >
                      + Add
                    </button>
                  </div>
                  {newPresetCustomEnv.map((item, i) => (
                    <div
                      key={i}
                      style={{ display: "flex", gap: 4, marginBottom: 3 }}
                    >
                      <input
                        type="text"
                        placeholder="ENV_KEY"
                        value={item.key}
                        onInput={(e) => {
                          const u = [...newPresetCustomEnv];
                          u[i] = {
                            ...u[i],
                            key: (e.target as HTMLInputElement).value,
                          };
                          setNewPresetCustomEnv(u);
                        }}
                        style={{
                          flex: 1,
                          background: "#1e293b",
                          border: "1px solid #334155",
                          color: "#e2e8f0",
                          padding: "4px 6px",
                          borderRadius: 4,
                          fontSize: 11,
                          fontFamily: "monospace",
                          boxSizing: "border-box",
                        }}
                      />
                      <input
                        type="text"
                        placeholder="value"
                        value={item.value}
                        onInput={(e) => {
                          const u = [...newPresetCustomEnv];
                          u[i] = {
                            ...u[i],
                            value: (e.target as HTMLInputElement).value,
                          };
                          setNewPresetCustomEnv(u);
                        }}
                        style={{
                          flex: 2,
                          background: "#1e293b",
                          border: "1px solid #334155",
                          color: "#e2e8f0",
                          padding: "4px 6px",
                          borderRadius: 4,
                          fontSize: 11,
                          boxSizing: "border-box",
                        }}
                      />
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          color: "#ef4444",
                          cursor: "pointer",
                          fontSize: 12,
                          padding: "0 4px",
                        }}
                        onClick={() =>
                          setNewPresetCustomEnv(
                            newPresetCustomEnv.filter((_, j) => j !== i),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ marginBottom: 6 }}>
                  <div
                    style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}
                  >
                    Init Message (sent after session starts)
                  </div>
                  <textarea
                    value={newPresetInit}
                    rows={2}
                    onInput={(e) =>
                      setNewPresetInit((e.target as HTMLTextAreaElement).value)
                    }
                    style={{
                      width: "100%",
                      background: "#1e293b",
                      border: "1px solid #334155",
                      color: "#e2e8f0",
                      padding: "5px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                      resize: "vertical",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                {presetError && (
                  <div style={{ color: "#ef4444", fontSize: 11, marginBottom: 6 }}>
                    {presetError}
                  </div>
                )}
                <button
                  type="button"
                  disabled={!newPresetName.trim() || !newPresetBaseUrl.trim()}
                  style={{
                    background: "#1d4ed8",
                    border: "none",
                    color: "#fff",
                    padding: "4px 12px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    opacity:
                      !newPresetName.trim() || !newPresetBaseUrl.trim()
                        ? 0.5
                        : 1,
                  }}
                  onClick={() => {
                    const preset = persistPresetDraft();
                    applyPresetDraft(createDefaultCcPresetDraft());
                    setCcPreset(preset.name);
                    setPresetError("");
                  }}
                >
                  Save Preset
                </button>
                <button
                  type="button"
                  disabled={
                    discoveringPreset
                    || !newPresetName.trim()
                    || !newPresetBaseUrl.trim()
                    || !newPresetToken.trim()
                  }
                  style={{
                    background: "#0f766e",
                    border: "none",
                    color: "#fff",
                    padding: "4px 12px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    marginLeft: 8,
                    opacity:
                      discoveringPreset
                      || !newPresetName.trim()
                      || !newPresetBaseUrl.trim()
                      || !newPresetToken.trim()
                        ? 0.5
                        : 1,
                  }}
                  onClick={() => {
                    if (!ws?.connected) {
                      setPresetError("Daemon offline");
                      return;
                    }
                    const preset = persistPresetDraft();
                    setCcPreset(preset.name);
                    setDiscoveringPreset(true);
                    setPresetError("");
                    try {
                      ws.send({
                        type: CC_PRESET_MSG.DISCOVER_MODELS,
                        requestId: `cc-preset-discover-${Date.now()}`,
                        presetName: preset.name,
                      });
                    } catch {
                      setDiscoveringPreset(false);
                      setPresetError("Failed to send discover request");
                    }
                  }}
                >
                  {discoveringPreset ? "Discovering..." : "Discover Models"}
                </button>

                {/* Existing presets — edit/delete */}
                {ccPresets.length > 0 && (
                  <div
                    style={{
                      marginTop: 10,
                      borderTop: "1px solid #334155",
                      paddingTop: 8,
                    }}
                  >
                    <div
                      style={{
                        color: "#64748b",
                        fontSize: 11,
                        marginBottom: 4,
                      }}
                    >
                      Saved presets:
                    </div>
                    {ccPresets.map((p) => (
                      <div
                        key={p.name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "3px 0",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ color: "#e2e8f0" }}>
                          {p.name}{" "}
                          <span style={{ color: "#475569" }}>
                            {p.env["ANTHROPIC_MODEL"] ?? ""}
                          </span>
                        </span>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            type="button"
                            style={{
                              background: "none",
                              border: "none",
                              color: "#3b82f6",
                              cursor: "pointer",
                              fontSize: 11,
                            }}
                            onClick={() => {
                              applyPresetDraft(createCcPresetDraftFromPreset(p));
                              setPresetError(p.modelDiscoveryError ?? "");
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            style={{
                              background: "none",
                              border: "none",
                              color: "#ef4444",
                              cursor: "pointer",
                              fontSize: 11,
                            }}
                            onClick={() => {
                              const updated = ccPresets.filter(
                                (x) => x.name !== p.name,
                              );
                              setCcPresets(updated);
                              try {
                                ws?.send({
                                  type: CC_PRESET_MSG.SAVE,
                                  presets: updated,
                                });
                              } catch {}
                              if (ccPreset === p.name) setCcPreset("");
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Extra init prompt for this launch */}
            {ccPreset && (
              <div class="form-group">
                <label>Extra init prompt (optional)</label>
                <textarea
                  placeholder="Additional instruction injected after session starts..."
                  value={ccInitPrompt}
                  rows={2}
                  onInput={(e) =>
                    setCcInitPrompt((e.target as HTMLTextAreaElement).value)
                  }
                  disabled={starting}
                  style={{
                    width: "100%",
                    background: "#0f172a",
                    border: "1px solid #334155",
                    color: "#e2e8f0",
                    padding: "8px 12px",
                    borderRadius: 4,
                    fontFamily: "inherit",
                    resize: "vertical",
                    fontSize: 13,
                  }}
                />
              </div>
            )}
          </>
        )}

        {/* Session description / persona (all agent types) */}
        <div class="form-group">
          <label>{t("session.description")}</label>
          <textarea
            placeholder={t("session.descriptionPlaceholder")}
            value={ocDescription}
            rows={2}
            onInput={(e) =>
              setOcDescription((e.target as HTMLTextAreaElement).value)
            }
            disabled={starting}
            style={{
              width: "100%",
              background: "#0f172a",
              border: "1px solid #334155",
              color: "#e2e8f0",
              padding: "8px 12px",
              borderRadius: 4,
              fontFamily: "inherit",
              resize: "vertical",
              fontSize: 13,
            }}
          />
        </div>

        {/* OpenClaw-specific options */}
        {agentType === "openclaw" && (
          <>
            <div class="form-group">
              <label>{t("session.sessionMode")}</label>
              <select
                value={ocMode}
                disabled={starting}
                onChange={(e) =>
                  setOcMode(
                    (e.target as HTMLSelectElement).value as OpenClawMode,
                  )
                }
                style={{
                  width: "100%",
                  background: "#0f172a",
                  border: "1px solid #334155",
                  color: "#e2e8f0",
                  padding: "8px 12px",
                  borderRadius: 4,
                  fontFamily: "inherit",
                }}
              >
                <option value="new">{t("session.newSession")}</option>
                <option value="bind">{t("session.bindExisting")}</option>
              </select>
            </div>

            {ocMode === "bind" ? (
              <div class="form-group">
                <label>{t("session.selectSession")}</label>
                {ocLoadingSessions ? (
                  <div
                    style={{ fontSize: 13, color: "#64748b", padding: "8px 0" }}
                  >
                    {t("session.loadingSessions")}
                  </div>
                ) : ocRemoteSessions.length === 0 ? (
                  <div
                    style={{ fontSize: 13, color: "#64748b", padding: "8px 0" }}
                  >
                    {t("session.noSessions")}
                  </div>
                ) : (
                  <select
                    value={ocSelectedSession}
                    disabled={starting}
                    onInput={(e) =>
                      setOcSelectedSession(
                        (e.target as HTMLSelectElement).value,
                      )
                    }
                    style={{
                      width: "100%",
                      background: "#0f172a",
                      border: "1px solid #334155",
                      color: "#e2e8f0",
                      padding: "8px 12px",
                      borderRadius: 4,
                      fontFamily: "inherit",
                    }}
                  >
                    <option value="">{t("session.selectSession")}</option>
                    {ocRemoteSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label || s.id}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <div class="form-group">
                <label>{t("session.sessionKey")}</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    value={ocSessionKey}
                    disabled={starting}
                    onInput={(e) =>
                      setOcSessionKey((e.target as HTMLInputElement).value)
                    }
                    autoComplete="off"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    class="btn btn-secondary"
                    disabled={starting}
                    onClick={() =>
                      setOcSessionKey(
                        `oc-${Math.random().toString(36).slice(2, 10)}`,
                      )
                    }
                    style={{ whiteSpace: "nowrap", fontSize: 12 }}
                  >
                    {t("session.autoGenerate")}
                  </button>
                </div>
              </div>
            )}

            <div class="form-group">
              <label>{t("session.description")}</label>
              <textarea
                placeholder={t("session.descriptionPlaceholder")}
                value={ocDescription}
                disabled={starting}
                onInput={(e) =>
                  setOcDescription((e.target as HTMLTextAreaElement).value)
                }
                rows={3}
                style={{
                  width: "100%",
                  background: "#0f172a",
                  border: "1px solid #334155",
                  color: "#e2e8f0",
                  padding: "8px 12px",
                  borderRadius: 4,
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
            </div>
          </>
        )}

        <div class="form-group">
          <label>Default shell (for terminal sub-session)</label>
          {shells.length > 0 ? (
            <select
              value={shellBin}
              disabled={starting}
              onInput={(e) =>
                setShellBin((e.target as HTMLSelectElement).value)
              }
              style={{
                width: "100%",
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#e2e8f0",
                padding: "8px 12px",
                borderRadius: 4,
                fontFamily: "inherit",
              }}
            >
              {shells.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="/bin/bash"
              value={shellBin}
              disabled={starting}
              onInput={(e) => setShellBin((e.target as HTMLInputElement).value)}
              autoComplete="off"
            />
          )}
        </div>

        {error && (
          <p
            style={{
              color: "#f87171",
              fontSize: 13,
              margin: "0 0 12px",
              background: "#450a0a",
              padding: "8px 12px",
              borderRadius: 4,
              border: "1px solid #7f1d1d",
            }}
          >
            {error}
          </p>
        )}

        {starting && (
          <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px" }}>
            {t("new_session.starting")}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            class="btn btn-secondary"
            onClick={onClose}
            disabled={starting}
          >
            {t("common.cancel")}
          </button>
          <button
            class="btn btn-primary"
            onClick={handleStart}
            disabled={starting}
          >
            {starting ? t("new_session.starting") : t("new_session.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
