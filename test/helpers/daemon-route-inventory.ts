import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT } from '../../shared/worker-session-snapshot.js';
import { USAGE_INGEST_ROUTE_SUFFIX } from '../../shared/usage-analytics.js';

const sharedSources = new Map<string, ts.SourceFile | null>();

export interface ApiPathUse { file: string; path: string; method?: string }
export function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sourceFiles(`${root}/${entry.name}`)
    : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [`${root}/${entry.name}`] : []);
}

/** AST scan (not grep): ignore comments; keep static suffixes around identifiers. */
export function scanApiPaths(file: string, text: string): ApiPathUse[] {
  if (!text.includes('/api/')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const uses: ApiPathUse[] = [];
  function methodFor(node: ts.Node): string | undefined {
    for (let p = node.parent; p; p = p.parent) {
      if (!ts.isCallExpression(p)) continue;
      for (const argument of p.arguments) if (ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) if (ts.isPropertyAssignment(property)
          && property.name.getText(sf) === 'method' && ts.isStringLiteral(property.initializer)) return property.initializer.text;
      }
      if (/fetch|doFetch/i.test(p.expression.getText(sf))) return 'GET';
    }
    return undefined; // URL helper: its dynamic methods are exercised by client tests.
  }
  function visit(node: ts.Node): void {
    let value: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    if (ts.isTemplateExpression(node)) {
      value = node.head.text;
      for (const span of node.templateSpans) {
        const symbol = span.expression.getText(sf);
        const staticValue = symbol === 'WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT' ? WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT
          : symbol === 'USAGE_INGEST_ROUTE_SUFFIX' ? USAGE_INGEST_ROUTE_SUFFIX : undefined;
        // A suffix helper can select several routes. Check its base here; the
        // real method+suffix combinations are checked by client flow tests.
        value += staticValue ?? (symbol === 'suffix' ? '' : ':param');
        value += span.literal.text;
      }
    }
    if (value?.includes('/api/')) {
      const at = value.indexOf('/api/');
      // An absolute third-party host is not the IM.codes server.
      if (!/^https?:\/\//.test(value)) uses.push({ file, path: value.slice(at).split('?')[0]!, method: methodFor(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return uses;
}

/** Named shared path constants used by clients must not escape the scan. */
export function scanImportedApiPaths(file: string, text: string): ApiPathUse[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const uses: ApiPathUse[] = [];
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || !node.moduleSpecifier.text.startsWith('.') || !node.moduleSpecifier.text.includes('/shared/') || !node.importClause?.namedBindings
      || !ts.isNamedImports(node.importClause.namedBindings)) continue;
    const target = resolve(dirname(file), node.moduleSpecifier.text.replace(/\.js$/, '.ts'));
    if (!sharedSources.has(target)) {
      const source = readFileSync(target, 'utf8');
      sharedSources.set(target, source.includes('/api/') ? ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true) : null);
    }
    const shared = sharedSources.get(target);
    if (!shared) continue;
    const names = new Set(node.importClause.namedBindings.elements.map((name) => (name.propertyName ?? name.name).text));
    for (const declaration of shared.statements) if (ts.isVariableStatement(declaration)) {
      for (const variable of declaration.declarationList.declarations) if (names.has(variable.name.getText(shared)) && variable.initializer) {
        // These constants may be a route prefix; a route below it must exist.
        for (const use of scanApiPaths(target, variable.initializer.getText(shared))) uses.push({ ...use, file });
      }
    }
  }
  return uses;
}

/** Non-daemon credentials / third-party / local-panel URLs are explicit exceptions. */
export function isNonDaemonApiUse(use: ApiPathUse): boolean {
  const exceptions: Record<string, readonly string[]> = {
    'src/bind/bind-flow.ts': ['/api/bind/verify', '/api/bind/direct', '/api/bind/rebind'], // body proof / account API key
    'src/node/enrollment.ts': ['/api/enroll/v2/redeem'], // one-use enrollment ticket
    'src/daemon/remote-desktop-login-screen.ts': ['/api/enroll/v2/download'], // enrollment ticket
    'src/daemon/server-link.ts': ['/api/server/:param/ws'], // WS handshake, not REST
    'src/node/runtime.ts': ['/api/server/:param/ws'], // controlled-node WS handshake
    'src/ops/verify-watch-sticky.ts': ['/api/server/:param/timeline/history', '/api/server/:param/session/send'], // operator CLI JWT
    'src/tracker/gitlab.ts': ['/api/v4'], // external GitLab API token
    'src/repo/detector.ts': ['/api/v3', '/api/v4'], // repository metadata, not a server call
  };
  // Shared local node UI paths never leave loopback and carry no server token.
  if (use.path === '/api/state' || use.path === '/api/action') return use.file.startsWith('src/node/');
  return exceptions[use.file]?.includes(use.path) ?? false;
}
