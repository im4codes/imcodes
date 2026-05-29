import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  suppressSqliteExperimentalWarning,
  __resetSqliteWarningSuppressionForTests,
} from '../../src/util/suppress-sqlite-warning.js';

describe('suppressSqliteExperimentalWarning', () => {
  let trueOriginal: typeof process.emitWarning;

  beforeEach(() => {
    // Ensure a clean, uninstalled baseline even if another module already
    // installed the shim earlier in this worker.
    __resetSqliteWarningSuppressionForTests();
    trueOriginal = process.emitWarning;
  });

  afterEach(() => {
    __resetSqliteWarningSuppressionForTests();
    process.emitWarning = trueOriginal;
  });

  it('drops only the node:sqlite ExperimentalWarning and forwards everything else', () => {
    // Install a controlled spy as the "original" the shim will wrap.
    const downstream = vi.fn();
    process.emitWarning = downstream as typeof process.emitWarning;

    suppressSqliteExperimentalWarning();

    // The exact node:sqlite warning — must be dropped.
    process.emitWarning(
      'SQLite is an experimental feature and might change at any time',
      'ExperimentalWarning',
    );
    expect(downstream).not.toHaveBeenCalled();

    // A different ExperimentalWarning — must pass through.
    process.emitWarning('Some other feature is experimental', 'ExperimentalWarning');
    expect(downstream).toHaveBeenCalledTimes(1);

    // A deprecation warning — must pass through.
    process.emitWarning('old api', 'DeprecationWarning');
    expect(downstream).toHaveBeenCalledTimes(2);

    // The options-object form is also recognised and dropped.
    process.emitWarning('SQLite is an experimental feature and might change at any time', {
      type: 'ExperimentalWarning',
    });
    expect(downstream).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — a second install does not double-wrap', () => {
    const downstream = vi.fn();
    process.emitWarning = downstream as typeof process.emitWarning;

    suppressSqliteExperimentalWarning();
    const afterFirst = process.emitWarning;
    suppressSqliteExperimentalWarning();
    expect(process.emitWarning).toBe(afterFirst);

    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    expect(downstream).not.toHaveBeenCalled();
  });
});
