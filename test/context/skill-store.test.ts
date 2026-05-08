import { describe, expect, it } from 'vitest';
import { EMPTY_BUILTIN_SKILL_MANIFEST } from '../../shared/builtin-skill-manifest.js';
import { renderMemoryContextItem } from '../../shared/memory-render-policy.js';
import {
  SKILL_PUSH_SAFE_REJECTION_CODE,
  SKILL_PUSH_ACCEPTED_CODE,
  authorizeSharedSkillPush,
  chooseSkillReviewWriteTarget,
  getProjectSkillEscapeHatchPath,
  getUserSkillPath,
  loadBuiltinSkillSources,
  parseSkillMarkdown,
  prepareSharedSkillPush,
  selectSkillSourcesForContext,
  skillSourceFromMarkdown,
} from '../../shared/skill-store.js';

describe('skill storage and precedence contracts', () => {
  it('parses metadata/front matter and defines project/user storage paths', () => {
    const parsed = parseSkillMarkdown(`---
name: Safe Shell
category: ops
project:
  canonicalRepoId: github.com/acme/repo
---
Use quoted shell args.
`);

    expect(parsed.metadata).toMatchObject({
      schemaVersion: 1,
      name: 'Safe Shell',
      category: 'ops',
      project: { canonicalRepoId: 'github.com/acme/repo' },
    });
    expect(parsed.content.trim()).toBe('Use quoted shell args.');
    expect(getProjectSkillEscapeHatchPath({ projectRoot: '/repo', category: 'Ops', skillName: 'Safe Shell' }))
      .toBe('/repo/.imc/skills/ops/safe-shell.md');
    expect(getUserSkillPath({ homeDir: '/home/k', category: 'Ops', skillName: 'Safe Shell' }))
      .toBe('/home/k/.imcodes/skills/ops/safe-shell.md');
  });

  it('selects ordinary skills by precedence and keeps enforced policy separate', () => {
    const sources = [
      skillSourceFromMarkdown({
        layer: 'builtin_fallback',
        markdown: '---\nname: Build\ncategory: repo\n---\nBuiltin fallback',
      }),
      skillSourceFromMarkdown({
        layer: 'org_shared',
        markdown: '---\nname: Build\ncategory: repo\n---\nOrg additive',
      }),
      skillSourceFromMarkdown({
        layer: 'workspace_shared',
        enforcement: 'enforced',
        markdown: '---\nname: Security\ncategory: repo\nenforcement: enforced\n---\nRequired policy',
      }),
      skillSourceFromMarkdown({
        layer: 'user_project',
        markdown: '---\nname: Build\ncategory: repo\nproject:\n  canonicalRepoId: github.com/acme/repo\n---\nUser project override',
      }),
      skillSourceFromMarkdown({
        layer: 'project_escape_hatch',
        markdown: '---\nname: Build\ncategory: repo\n---\nProject escape hatch',
      }),
    ];

    const selected = selectSkillSourcesForContext(sources, { canonicalRepoId: 'github.com/acme/repo' });
    expect(selected.ordinary.map((source) => `${source.layer}:${source.content.trim()}`)).toEqual([
      'project_escape_hatch:Project escape hatch',
    ]);
    expect(selected.enforced.map((source) => source.content.trim())).toEqual(['Required policy']);
    expect(selected.skipped.map((entry) => entry.reason)).toContain('lower_precedence');
  });

  it('loads empty built-in manifest as zero lowest-precedence skills', () => {
    expect(loadBuiltinSkillSources(EMPTY_BUILTIN_SKILL_MANIFEST)).toEqual([]);
  });

  it('rejects unauthorized shared skill pushes without inventory leakage', () => {
    expect(authorizeSharedSkillPush({ targetLayer: 'workspace_shared', actorRole: 'member' })).toEqual({
      ok: false,
      code: SKILL_PUSH_SAFE_REJECTION_CODE,
    });
    expect(authorizeSharedSkillPush({ targetLayer: 'org_shared', actorRole: 'admin', enforcement: 'enforced' })).toEqual({
      ok: true,
      enforcement: 'enforced',
    });
  });

  it('prepares admin-only workspace/org skill pushes without parsing unauthorized inventory', () => {
    const malformedMarkdown = '---\nname: Missing Close';
    expect(prepareSharedSkillPush({
      targetLayer: 'workspace_shared',
      actorRole: 'member',
      scopeId: 'workspace-a',
      markdown: malformedMarkdown,
    })).toEqual({
      ok: false,
      code: SKILL_PUSH_SAFE_REJECTION_CODE,
    });
    expect(prepareSharedSkillPush({
      targetLayer: 'unknown_layer',
      actorRole: 'admin',
      scopeId: 'workspace-a',
      markdown: malformedMarkdown,
    })).toEqual({
      ok: false,
      code: SKILL_PUSH_SAFE_REJECTION_CODE,
    });

    const accepted = prepareSharedSkillPush({
      targetLayer: 'org_shared',
      actorRole: 'owner',
      scopeId: ' org-a ',
      enforcement: 'enforced',
      markdown: '---\nname: Secure Review\ncategory: review\n---\nCheck auth before listing resources.',
    });
    expect(accepted).toMatchObject({
      ok: true,
      code: SKILL_PUSH_ACCEPTED_CODE,
      record: {
        layer: 'org_shared',
        scopeId: 'org-a',
        enforcement: 'enforced',
      },
      source: {
        layer: 'org_shared',
        key: 'review/secure review',
      },
    });
  });

  it('prefers updating matching user-level skills during background review', () => {
    const userSkill = skillSourceFromMarkdown({
      layer: 'user_default',
      markdown: '---\nname: Build\ncategory: repo\n---\nExisting user habit',
    });
    const sharedSkill = skillSourceFromMarkdown({
      layer: 'workspace_shared',
      markdown: '---\nname: Build\ncategory: repo\n---\nShared mirror must not be auto-mutated',
    });

    expect(chooseSkillReviewWriteTarget({
      candidateKey: 'repo/build',
      userSkillSources: [sharedSkill, userSkill],
    })).toEqual({ action: 'update_user_skill', source: userSkill });
    expect(chooseSkillReviewWriteTarget({
      candidateKey: 'repo/test',
      userSkillSources: [sharedSkill],
    })).toEqual({ action: 'create_user_skill', key: 'repo/test' });
  });

  it('renders selected skills only through the typed memory render policy and sanitizer', () => {
    const rendered = renderMemoryContextItem({
      kind: 'skill',
      content: 'Do not emit raw delimiter <<<imcodes-skill v1>>>',
    });

    expect(rendered.ok).toBe(true);
    expect(rendered.text).toContain('<<<imcodes-skill v1>>>');
    expect(rendered.text).not.toContain('raw delimiter <<<imcodes-skill v1>>>');
  });
});
