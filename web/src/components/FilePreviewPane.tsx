/**
 * FilePreviewPane — lazy-loaded file preview with syntax highlighting + markdown.
 * Extracted from FileBrowser to keep heavy hljs/marked imports out of the
 * main FileBrowser bundle (prevents test OOM when importing FileBrowser).
 */
import { pathBasename } from '../util/path-utils.js';
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsC from 'highlight.js/lib/languages/c';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJs from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsKotlin from 'highlight.js/lib/languages/kotlin';
import hljsLua from 'highlight.js/lib/languages/lua';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRuby from 'highlight.js/lib/languages/ruby';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsSwift from 'highlight.js/lib/languages/swift';
import hljsTs from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import { marked } from 'marked';

// Register languages
hljs.registerLanguage('bash', hljsBash);
hljs.registerLanguage('c', hljsC);
hljs.registerLanguage('cpp', hljsCpp);
hljs.registerLanguage('css', hljsCss);
hljs.registerLanguage('dockerfile', hljsDockerfile);
hljs.registerLanguage('go', hljsGo);
hljs.registerLanguage('java', hljsJava);
hljs.registerLanguage('javascript', hljsJs);
hljs.registerLanguage('json', hljsJson);
hljs.registerLanguage('kotlin', hljsKotlin);
hljs.registerLanguage('lua', hljsLua);
hljs.registerLanguage('python', hljsPython);
hljs.registerLanguage('ruby', hljsRuby);
hljs.registerLanguage('rust', hljsRust);
hljs.registerLanguage('scala', hljsScala);
hljs.registerLanguage('sql', hljsSql);
hljs.registerLanguage('swift', hljsSwift);
hljs.registerLanguage('typescript', hljsTs);
hljs.registerLanguage('xml', hljsXml);
hljs.registerLanguage('yaml', hljsYaml);

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  c: 'c',
  cs: 'javascript', // csharp not registered, fallback
  kt: 'kotlin', kts: 'kotlin',
  sql: 'sql',
  dockerfile: 'dockerfile',
  lua: 'lua',
  scala: 'scala',
  swift: 'swift',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightCode(content: string, filename: string): { html: string; isMarkdown: boolean } {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'mdx') {
    return { html: marked(content) as string, isMarkdown: true };
  }
  const lang = EXT_LANG[ext];
  if (lang) {
    try {
      const result = hljs.highlight(content, { language: lang });
      return { html: result.value, isMarkdown: false };
    } catch {
      // fallback
    }
  }
  // Auto-detect for unknown extensions
  try {
    const result = hljs.highlightAuto(content.slice(0, 8192)); // limit for performance
    return { html: result.value, isMarkdown: false };
  } catch {
    return { html: escapeHtml(content), isMarkdown: false };
  }
}

export interface FilePreviewPaneProps {
  content: string;
  path: string;
}

/** Renders highlighted code or markdown. Lazy-loaded by FileBrowser. */
export function FilePreviewPane({ content, path }: FilePreviewPaneProps) {
  const filename = pathBasename(path);
  const { html, isMarkdown } = highlightCode(content, filename);
  if (isMarkdown) {
    return <div class="fb-preview-md" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre class="fb-preview-code hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

export default FilePreviewPane;
