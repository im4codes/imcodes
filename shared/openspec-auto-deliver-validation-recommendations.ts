import type { OpenSpecAutoDeliverValidationRecommendation } from './openspec-auto-deliver-types.js';

export interface OpenSpecAutoDeliverProjectFile {
  path: string;
  content: string;
}

const UNSAFE_SCRIPT_RE = /\b(deploy|publish|release|migrate|migration|prisma\s+migrate|rm\s+-rf|docker\s+push|kubectl|terraform\s+apply|serverless\s+deploy)\b/i;

function parsePackageJson(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === 'string') scripts[name] = value;
    }
    return scripts;
  } catch {
    return {};
  }
}

function packageManagerCommand(files: OpenSpecAutoDeliverProjectFile[], script: string): string {
  if (files.some((file) => file.path.endsWith('pnpm-lock.yaml'))) return `pnpm ${script}`;
  if (files.some((file) => file.path.endsWith('yarn.lock'))) return `yarn ${script}`;
  if (files.some((file) => file.path.endsWith('package-lock.json'))) return `npm run ${script}`;
  return `npm run ${script}`;
}

export function buildOpenSpecAutoDeliverValidationRecommendations(
  files: OpenSpecAutoDeliverProjectFile[],
): OpenSpecAutoDeliverValidationRecommendation[] {
  const recommendations: OpenSpecAutoDeliverValidationRecommendation[] = [];
  const packageJson = files.find((file) => file.path.endsWith('package.json'));
  if (packageJson) {
    const scripts = parsePackageJson(packageJson.content);
    for (const scriptName of ['typecheck', 'test', 'lint', 'build']) {
      const script = scripts[scriptName];
      if (!script) continue;
      recommendations.push({
        command: packageManagerCommand(files, scriptName),
        reason: `${scriptName} script is declared in package.json.`,
        safety: UNSAFE_SCRIPT_RE.test(script) ? 'unsafe' : 'recommended',
        sourceFile: packageJson.path,
      });
    }
    for (const [scriptName, script] of Object.entries(scripts)) {
      if (!UNSAFE_SCRIPT_RE.test(script)) continue;
      recommendations.push({
        command: packageManagerCommand(files, scriptName),
        reason: `Script appears side-effectful or deploy-like: ${script}`,
        safety: 'unsafe',
        sourceFile: packageJson.path,
      });
    }
  }
  const pyproject = files.find((file) => file.path.endsWith('pyproject.toml'));
  if (pyproject) {
    recommendations.push({
      command: 'pytest',
      reason: 'pyproject.toml suggests a Python project; pytest is a common non-deploy validation command when available.',
      safety: 'unknown',
      sourceFile: pyproject.path,
    });
  }
  return recommendations;
}

