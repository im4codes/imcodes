import { describe, expect, it } from 'vitest';
import type { CloudDocFolder, CloudDocItem, SharedCloudDocItem, SharedCloudFolderItem } from '@shared/cloud-docs.js';
import {
  filterCloudDocReferences,
  matchInlineCloudDocTrigger,
  mergeCloudDocReferences,
  normalizeCloudDocReferences,
  replaceInlineCloudDocTrigger,
} from '../../src/util/cloud-doc-reference.js';

describe('cloud-doc-reference helpers', () => {
  it('matches inline & triggers at start, after whitespace, and after CJK/fullwidth punctuation', () => {
    expect(matchInlineCloudDocTrigger('&')).toBe('');
    expect(matchInlineCloudDocTrigger('&方案')).toBe('方案');
    expect(matchInlineCloudDocTrigger('看看 &方案')).toBe('方案');
    expect(matchInlineCloudDocTrigger('帮我看下&方案')).toBe('方案');
    expect(matchInlineCloudDocTrigger('请参考，&架构设计.md')).toBe('架构设计.md');
    expect(matchInlineCloudDocTrigger('第一行\n&plan')).toBe('plan');
  });

  it('rejects &&, ASCII-adjacent &, URL query params, and triggers followed by whitespace', () => {
    expect(matchInlineCloudDocTrigger('&&')).toBeNull();
    expect(matchInlineCloudDocTrigger('cmd1 && cmd2')).toBeNull();
    expect(matchInlineCloudDocTrigger('cmd1 &&')).toBeNull();
    expect(matchInlineCloudDocTrigger('看看&&方案')).toBeNull();
    expect(matchInlineCloudDocTrigger('R&D')).toBeNull();
    expect(matchInlineCloudDocTrigger('a&b')).toBeNull();
    expect(matchInlineCloudDocTrigger('https://example.com?a=1&b=2')).toBeNull();
    expect(matchInlineCloudDocTrigger('& ')).toBeNull();
    expect(matchInlineCloudDocTrigger('&方案 ')).toBeNull();
    expect(matchInlineCloudDocTrigger('&方案\n')).toBeNull();
    expect(matchInlineCloudDocTrigger('帮我看下[CloudDoc: R&D 方案 | id=doc_1] ')).toBeNull();
  });

  it('normalizes personal + shared docs, attaches folder names, deduplicates by id, and sorts newest first', () => {
    const folders: CloudDocFolder[] = [
      { id: 'fld-1', userId: 'u1', parentId: null, name: 'Specs', createdAt: 1, updatedAt: 10 },
    ];
    const sharedFolders: SharedCloudFolderItem[] = [
      {
        id: 'fld-s1',
        userId: 'u2',
        parentId: null,
        name: 'Team Docs',
        createdAt: 1,
        updatedAt: 10,
        role: 'viewer',
        allowDownload: true,
        ownerName: 'Alice',
        ownerUsername: 'alice',
        sharedTeamName: null,
      },
    ];
    const docs: CloudDocItem[] = [
      {
        id: 'doc-1',
        userId: 'u1',
        folderId: 'fld-1',
        name: '架构方案.md',
        ext: '.md',
        mimeType: 'text/markdown',
        sizeBytes: 100,
        docVersion: 1,
        createdAt: 1,
        updatedAt: 200,
        lastOpenedAt: null,
      },
    ];
    const sharedDocs: SharedCloudDocItem[] = [
      {
        id: 'doc-1', // duplicate id should prefer personal doc
        userId: 'u2',
        folderId: 'fld-s1',
        name: 'Shared duplicate',
        ext: '.md',
        mimeType: 'text/markdown',
        sizeBytes: 100,
        docVersion: 1,
        createdAt: 1,
        updatedAt: 999,
        lastOpenedAt: null,
        role: 'viewer',
        allowDownload: true,
        ownerName: 'Bob',
        ownerUsername: 'bob',
        sharedVia: 'doc',
        sharedTeamName: null,
        folderName: 'Team Docs',
      },
      {
        id: 'doc-2',
        userId: 'u2',
        folderId: 'fld-s1',
        name: 'Roadmap.docx',
        ext: '.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 200,
        docVersion: 1,
        createdAt: 1,
        updatedAt: 500,
        lastOpenedAt: null,
        role: 'editor',
        allowDownload: true,
        ownerName: 'Alice',
        ownerUsername: 'alice',
        sharedVia: 'folder',
        sharedTeamName: 'Core',
        folderName: null,
      },
    ];

    const normalized = normalizeCloudDocReferences({ folders, docs, sharedFolders, sharedDocs });
    expect(normalized).toEqual([
      {
        id: 'doc-2',
        name: 'Roadmap.docx',
        updatedAt: 500,
        folderName: 'Team Docs',
        shared: true,
        ownerLabel: 'Alice',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      {
        id: 'doc-1',
        name: '架构方案.md',
        updatedAt: 200,
        folderName: 'Specs',
        mimeType: 'text/markdown',
      },
    ]);
  });

  it('merges cached and search results and filters case-insensitively by name, id, and folderName', () => {
    const merged = mergeCloudDocReferences(
      [{ id: 'doc-1', name: '方案.md', updatedAt: 100, folderName: 'Arch' }],
      [{ id: 'doc-2', name: 'API Spec.md', updatedAt: 300 }],
    );
    expect(merged.map((d) => d.id)).toEqual(['doc-2', 'doc-1']);
    expect(filterCloudDocReferences(merged, 'arch').map((d) => d.id)).toEqual(['doc-1']);
    expect(filterCloudDocReferences(merged, 'DOC-2').map((d) => d.id)).toEqual(['doc-2']);
    expect(filterCloudDocReferences(merged, 'spec').map((d) => d.id)).toEqual(['doc-2']);
  });

  it('replaces trailing &query with canonical citation while preserving prefix and never re-triggering', () => {
    expect(replaceInlineCloudDocTrigger('&方案', { id: 'doc_1', name: '方案.md' }))
      .toBe('[CloudDoc: 方案.md | id=doc_1] ');
    expect(replaceInlineCloudDocTrigger('看看 &方案', { id: 'doc_1', name: '方案.md' }))
      .toBe('看看 [CloudDoc: 方案.md | id=doc_1] ');
    expect(replaceInlineCloudDocTrigger('帮我看下&方案', { id: 'doc_1', name: '方案.md' }))
      .toBe('帮我看下[CloudDoc: 方案.md | id=doc_1] ');

    const tricky = replaceInlineCloudDocTrigger('帮我看下&研发', {
      id: 'doc_rd',
      name: 'R&D [Draft] 方案.docx',
    });
    expect(tricky).toBe('帮我看下[CloudDoc: R&D [Draft 方案.docx | id=doc_rd] ');
    expect(matchInlineCloudDocTrigger(tricky)).toBeNull();
  });
});
