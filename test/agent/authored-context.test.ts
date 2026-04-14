import { describe, expect, it } from 'vitest';
import { selectRuntimeAuthoredContext } from '../../src/agent/authored-context.js';

describe('selectRuntimeAuthoredContext', () => {
  it('prioritizes required bindings before advisory and narrower scopes before wider scopes', () => {
    const result = selectRuntimeAuthoredContext({
      repository: 'github.com/acme/repo',
      language: 'ts',
      filePath: 'src/app.ts',
      bindings: [
        {
          bindingId: 'org-advisory',
          documentVersionId: 'v-org',
          mode: 'advisory',
          scope: 'org_shared',
          content: 'Org style guide',
        },
        {
          bindingId: 'workspace-required',
          documentVersionId: 'v-workspace',
          mode: 'required',
          scope: 'workspace_shared',
          language: 'ts',
          content: 'Workspace TS rules',
        },
        {
          bindingId: 'project-required',
          documentVersionId: 'v-project',
          mode: 'required',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          content: 'Project coding standard',
        },
      ],
    });

    expect(result.required).toEqual(['Project coding standard', 'Workspace TS rules']);
    expect(result.advisory).toEqual(['Org style guide']);
    expect(result.appliedDocumentVersionIds).toEqual(['v-project', 'v-workspace', 'v-org']);
  });

  it('excludes deactivated and superseded bindings from new retrieval', () => {
    const result = selectRuntimeAuthoredContext({
      bindings: [
        {
          bindingId: 'inactive',
          documentVersionId: 'v1',
          mode: 'required',
          scope: 'project_shared',
          content: 'Inactive',
          active: false,
        },
        {
          bindingId: 'superseded',
          documentVersionId: 'v2',
          mode: 'advisory',
          scope: 'project_shared',
          content: 'Superseded',
          superseded: true,
        },
      ],
    });

    expect(result.required).toEqual([]);
    expect(result.advisory).toEqual([]);
    expect(result.appliedDocumentVersionIds).toEqual([]);
  });

  it('uses a deterministic document-version tie-break within the same precedence tier', () => {
    const result = selectRuntimeAuthoredContext({
      repository: 'github.com/acme/repo',
      bindings: [
        {
          bindingId: 'b',
          documentVersionId: 'v-2',
          mode: 'advisory',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          content: 'Second',
        },
        {
          bindingId: 'a',
          documentVersionId: 'v-1',
          mode: 'advisory',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          content: 'First',
        },
      ],
    });

    expect(result.advisory).toEqual(['First', 'Second']);
    expect(result.appliedDocumentVersionIds).toEqual(['v-1', 'v-2']);
  });

  it('uses repository, then language, then path applicability in a deterministic order', () => {
    const result = selectRuntimeAuthoredContext({
      repository: 'github.com/acme/repo',
      language: 'ts',
      filePath: 'src/features/app.ts',
      bindings: [
        {
          bindingId: 'path-only',
          documentVersionId: 'v-path',
          mode: 'advisory',
          scope: 'project_shared',
          pathPattern: 'src/features/**',
          content: 'Path guidance',
        },
        {
          bindingId: 'lang',
          documentVersionId: 'v-lang',
          mode: 'advisory',
          scope: 'project_shared',
          language: 'ts',
          content: 'Language guidance',
        },
        {
          bindingId: 'repo',
          documentVersionId: 'v-repo',
          mode: 'advisory',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          content: 'Repository guidance',
        },
      ],
    });

    expect(result.advisory).toEqual(['Repository guidance', 'Language guidance', 'Path guidance']);
  });

  it('rejects bindings with an explicit repository selector that does not match the target repository', () => {
    const result = selectRuntimeAuthoredContext({
      repository: 'github.com/acme/repo',
      language: 'ts',
      filePath: 'src/app.ts',
      bindings: [
        {
          bindingId: 'wrong-repo',
          documentVersionId: 'v-wrong',
          mode: 'required',
          scope: 'project_shared',
          repository: 'github.com/other/repo',
          language: 'ts',
          content: 'Must not apply',
        },
        {
          bindingId: 'correct-lang',
          documentVersionId: 'v-right',
          mode: 'advisory',
          scope: 'workspace_shared',
          language: 'ts',
          content: 'Language guidance',
        },
      ],
    });

    expect(result.required).toEqual([]);
    expect(result.advisory).toEqual(['Language guidance']);
    expect(result.appliedDocumentVersionIds).toEqual(['v-right']);
  });
});
