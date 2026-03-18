/**
 * Parse agent completion reports for structured review data.
 * Extracts files changed, tests run, summary from agent output.
 */

export interface CompletionReport {
  summary: string;
  filesChanged: string[];
  testsRun: boolean;
  testsPassed: boolean;
  errors: string[];
  commitSha?: string;
  raw: string;
}

/**
 * Parse an agent's completion output into a structured report.
 */
export function parseCompletionReport(output: string): CompletionReport {
  const lines = output.split('\n');
  const report: CompletionReport = {
    summary: '',
    filesChanged: [],
    testsRun: false,
    testsPassed: false,
    errors: [],
    raw: output,
  };

  // Extract summary (first non-empty paragraph or a "Summary:" section)
  const summaryMatch = output.match(/(?:summary:|completed?:?)\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (summaryMatch) {
    report.summary = summaryMatch[1].trim();
  } else {
    // Use first non-empty line
    report.summary = lines.find((l) => l.trim().length > 10)?.trim() ?? '';
  }

  // Extract files changed
  // Look for patterns like: "- Modified: src/foo.ts", "● Write file src/bar.ts", etc.
  const filePatterns = [
    /(?:modified|created|wrote|write file|read file|edit)\s+([^\s,]+\.(?:ts|js|py|go|rs|json|yaml|yml|md|css|html|tsx|jsx))/gi,
    /^[\s-]*([a-z][a-z0-9/._-]+\.(?:ts|js|py|go|rs|json|yaml|yml|md|css|html|tsx|jsx))\s*(?:modified|changed|created|updated)?$/gim,
  ];

  const foundFiles = new Set<string>();
  for (const pattern of filePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      foundFiles.add(match[1]);
    }
  }
  report.filesChanged = Array.from(foundFiles);

  // Detect test execution
  const testIndicators = ['npm test', 'yarn test', 'pnpm test', 'vitest', 'jest', 'pytest', 'cargo test', 'go test'];
  report.testsRun = testIndicators.some((ind) => output.toLowerCase().includes(ind));

  // Detect test results
  if (report.testsRun) {
    const passPatterns = [/all tests? passed/i, /✓ \d+/i, /\d+ pass/i, /tests? pass/i];
    const failPatterns = [/tests? failed/i, /✗ \d+/i, /\d+ fail/i, /test failure/i];
    report.testsPassed = passPatterns.some((p) => p.test(output)) && !failPatterns.some((p) => p.test(output));
  }

  // Extract errors
  const errorPatterns = [
    /(?:error|exception|failed?):\s+([^\n]+)/gi,
    /^[A-Z][a-zA-Z]+Error:\s+([^\n]+)/gm,
  ];
  for (const pattern of errorPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      if (match[1] && !match[1].toLowerCase().includes('no error')) {
        report.errors.push(match[1].trim());
      }
    }
  }
  // Deduplicate errors
  report.errors = [...new Set(report.errors)].slice(0, 10);

  // Extract git commit SHA
  const shaMatch = output.match(/\b([a-f0-9]{7,40})\b/i);
  if (shaMatch) report.commitSha = shaMatch[1];

  return report;
}
