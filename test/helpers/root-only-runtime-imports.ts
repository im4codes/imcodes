import ts from 'typescript';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

/** Parse executable static edges, not comments, strings, or erased type imports. */
export function runtimeImports(text: string, file = 'module.ts'): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const result: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && !clause?.name && bindings.elements.length
        && bindings.elements.every(element => element.isTypeOnly)) continue;
      if (ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length
        && clause.elements.every(element => element.isTypeOnly)) continue;
      if (ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression
      && ts.isStringLiteral(node.moduleReference.expression)) {
      result.push(node.moduleReference.expression.text);
    }
  }
  return result;
}

/** One cached static graph pass; never loads modules or starts a nested test suite. */
export function rootOnlyRuntimeDependencies(root: string, entries: string[]) {
  const rootRequire = createRequire(resolve(root, 'package.json'));
  const pending = entries.map(file => resolve(root, file));
  const visited = new Set<string>();
  const packages = new Map<string, string>();
  let serverFiles = 0;
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    const inServer = relative(resolve(root, 'server'), file).split(/[\\/]/)[0] !== '..';
    if (inServer) serverFiles++;
    for (const specifier of runtimeImports(readFileSync(file, 'utf8'), file)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        const candidates = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'),
          `${target}.ts`, `${target}.tsx`, resolve(target, 'index.ts')];
        const next = candidates.find(path => existsSync(path) && statSync(path).isFile());
        if (next && !next.endsWith('.json') && !next.endsWith('.d.ts')) pending.push(next);
      } else if (inServer && !isBuiltin(specifier)) {
        // Resolve from ROOT only, even when server/node_modules happens to exist.
        // This is the CI install boundary, not an arbitrary ban on thin server code.
        if (!packages.has(specifier)) packages.set(specifier, file);
      }
    }
  }
  const missing = [...packages].flatMap(([specifier, file]) => {
    try { rootRequire.resolve(specifier); return []; }
    catch { return [{ specifier, file: relative(root, file) }]; }
  });
  return { missing, files: visited.size, serverFiles };
}
