import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  VOICE_HOTWORDS_MAX_TERMS,
  mergeVoiceHotwords,
  parseVoiceHotwordsInput,
} from '@shared/voice-hotwords.js';
import {
  getActiveVoiceHotwordProject,
  getGlobalVoiceHotwordsRaw,
  getProjectVoiceHotwordsRaw,
  getShareHotwordsWithOthers,
  listVoiceHotwordProjectKeys,
  normalizeVoiceHotwordProjectKey,
  setGlobalVoiceHotwordsRaw,
  setProjectVoiceHotwordsRaw,
  setShareHotwordsWithOthers,
  subscribeVoiceHotwordsChange,
} from '../voice-hotwords.js';

interface Props {
  currentProjectName?: string | null;
}

const fieldLabelStyle = { fontSize: '13px', fontWeight: 600, color: '#e2e8f0' } as const;
const hintStyle = { fontSize: '12px', color: '#94a3b8', lineHeight: 1.45 } as const;
const textareaStyle = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 84,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(148, 163, 184, 0.24)',
  background: 'rgba(15, 23, 42, 0.6)',
  color: '#e2e8f0',
  fontSize: '12px',
  lineHeight: 1.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  resize: 'vertical',
} as const;

export function VoiceHotwordsSection({ currentProjectName }: Props) {
  const { t } = useTranslation();
  const [selectedProject, setSelectedProject] = useState<string | null>(() => (
    normalizeVoiceHotwordProjectKey(currentProjectName)
    ?? getActiveVoiceHotwordProject()
    ?? listVoiceHotwordProjectKeys()[0]
    ?? null
  ));
  const [projectRaw, setProjectRaw] = useState<string>(() => (
    selectedProject ? getProjectVoiceHotwordsRaw(selectedProject) : ''
  ));
  const [globalRaw, setGlobalRaw] = useState<string>(() => getGlobalVoiceHotwordsRaw());
  const [shareWithOthers, setShareWithOthersState] = useState<boolean>(() => getShareHotwordsWithOthers());

  const projectOptions = useMemo(() => {
    const keys = new Set(listVoiceHotwordProjectKeys());
    const explicit = normalizeVoiceHotwordProjectKey(currentProjectName) ?? getActiveVoiceHotwordProject();
    if (explicit) keys.add(explicit);
    if (selectedProject) keys.add(selectedProject);
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [currentProjectName, selectedProject, projectRaw]);

  useEffect(() => {
    const nextCurrent = normalizeVoiceHotwordProjectKey(currentProjectName);
    if (nextCurrent) {
      setSelectedProject(nextCurrent);
    }
  }, [currentProjectName]);

  useEffect(() => {
    setProjectRaw(selectedProject ? getProjectVoiceHotwordsRaw(selectedProject) : '');
    setGlobalRaw(getGlobalVoiceHotwordsRaw());
    setShareWithOthersState(getShareHotwordsWithOthers());
    return subscribeVoiceHotwordsChange(() => {
      setProjectRaw(selectedProject ? getProjectVoiceHotwordsRaw(selectedProject) : '');
      setGlobalRaw(getGlobalVoiceHotwordsRaw());
      setShareWithOthersState(getShareHotwordsWithOthers());
    });
  }, [selectedProject]);

  const projectCount = useMemo(() => parseVoiceHotwordsInput(projectRaw).terms.length, [projectRaw]);
  const globalCount = useMemo(() => parseVoiceHotwordsInput(globalRaw).terms.length, [globalRaw]);
  const mergedCount = useMemo(
    () => mergeVoiceHotwords({ projectRaw: selectedProject ? projectRaw : '', globalRaw }).terms.length,
    [selectedProject, projectRaw, globalRaw],
  );

  const handleProjectSelect = (e: Event) => {
    const el = (e.currentTarget ?? e.target) as HTMLSelectElement;
    const next = el.value || null;
    setSelectedProject(next);
    setProjectRaw(next ? getProjectVoiceHotwordsRaw(next) : '');
  };

  return (
    <div class="settings-card" data-testid="settings-voice-hotwords-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h2 class="settings-card-heading" style={{ marginBottom: 0 }}>
          {t('settings.voice_hotwords_title')}
        </h2>
        <span style={{ fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
          {t('settings.voice_hotwords_count', { count: mergedCount, max: VOICE_HOTWORDS_MAX_TERMS })}
        </span>
      </div>

      <p style={{ ...hintStyle, marginTop: 6, marginBottom: 12 }}>
        {t('settings.voice_hotwords_desc')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={fieldLabelStyle}>
              {selectedProject
                ? t('settings.voice_hotwords_project_label', { project: selectedProject })
                : t('settings.voice_hotwords_project_empty_title')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {projectOptions.length > 1 && (
                <select
                  aria-label={t('settings.voice_hotwords_project_select')}
                  data-testid="voice-hotwords-project-select"
                  value={selectedProject ?? ''}
                  onInput={handleProjectSelect}
                  onChange={handleProjectSelect}
                  style={{
                    background: 'rgba(15, 23, 42, 0.7)',
                    color: '#e2e8f0',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    fontSize: '12px',
                  }}
                >
                  {projectOptions.map((key) => (
                    <option key={key} value={key} selected={selectedProject === key}>{key}</option>
                  ))}
                </select>
              )}
              {selectedProject && (
                <span style={{ fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {t('settings.voice_hotwords_count', { count: projectCount, max: VOICE_HOTWORDS_MAX_TERMS })}
                </span>
              )}
            </div>
          </div>

          {selectedProject ? (
            <textarea
              key={selectedProject}
              data-testid="voice-hotwords-project-input"
              value={projectRaw}
              placeholder={t('settings.voice_hotwords_project_placeholder')}
              onInput={(e) => {
                const next = (e.currentTarget as HTMLTextAreaElement).value;
                setProjectRaw(next);
                setProjectVoiceHotwordsRaw(selectedProject, next);
              }}
              style={textareaStyle}
            />
          ) : (
            <div data-testid="voice-hotwords-no-project" style={hintStyle}>
              {t('settings.voice_hotwords_no_project')}
            </div>
          )}
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <div style={fieldLabelStyle}>{t('settings.voice_hotwords_global_label')}</div>
            <span style={{ fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
              {t('settings.voice_hotwords_count', { count: globalCount, max: VOICE_HOTWORDS_MAX_TERMS })}
            </span>
          </div>
          <textarea
            data-testid="voice-hotwords-global-input"
            value={globalRaw}
            placeholder={t('settings.voice_hotwords_global_placeholder')}
            onInput={(e) => {
              const next = (e.currentTarget as HTMLTextAreaElement).value;
              setGlobalRaw(next);
              setGlobalVoiceHotwordsRaw(next);
            }}
            style={textareaStyle}
          />
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: 4 }}>
            {t('settings.voice_hotwords_hint')}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            paddingTop: 4,
            borderTop: '1px solid rgba(148, 163, 184, 0.12)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 200px' }}>
            <div style={fieldLabelStyle}>{t('settings.voice_hotwords_share_toggle')}</div>
            <div style={hintStyle}>{t('settings.voice_hotwords_share_desc')}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={shareWithOthers}
            data-testid="voice-hotwords-share-toggle"
            class={shareWithOthers ? 'settings-btn-primary' : 'settings-btn-secondary'}
            style={{ minWidth: 52, padding: '6px 12px', fontSize: '12px', flexShrink: 0 }}
            onClick={() => {
              const next = !shareWithOthers;
              setShareWithOthersState(next);
              setShareHotwordsWithOthers(next);
            }}
          >
            {shareWithOthers
              ? t('common.on', { defaultValue: 'On' })
              : t('common.off', { defaultValue: 'Off' })}
          </button>
        </div>
      </div>
    </div>
  );
}
