import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../../src/index.js';
import { PROJECT_ROOT } from '../../src/util/project-root.js';

function captureProgram(program: Command): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  program.configureOutput({
    writeOut: (value) => out.push(value),
    writeErr: (value) => err.push(value),
  });
  return { out, err };
}

describe('imcodes CLI program', () => {
  it('builds the top-level command tree without starting daemon side effects', () => {
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name()).sort();

    expect(program.name()).toBe('imcodes');
    expect(program.description()).toBe('Remote AI coding agent controller');
    expect(commandNames).toEqual(expect.arrayContaining([
      'bind',
      'connect',
      'disconnect',
      'memory',
      'project',
      'send',
      'service',
      'setup',
      'start',
      'status',
      'stop',
    ]));

    const project = program.commands.find((command) => command.name() === 'project');
    expect(project?.commands.map((command) => command.name()).sort()).toEqual(['start', 'stop']);

    const memory = program.commands.find((command) => command.name() === 'memory');
    expect(memory?.commands.map((command) => command.name()).sort()).toEqual(['list', 'search', 'stats']);
  });

  it('prints help through commander without invoking command actions', async () => {
    const program = createProgram();
    const { out } = captureProgram(program);

    await expect(program.parseAsync(['node', 'imcodes', '--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });

    const help = out.join('');
    expect(help).toContain('Remote AI coding agent controller');
    expect(help).toContain('Usage: imcodes');
    expect(help).toContain('start');
    expect(help).toContain('send');
    expect(help).toContain('memory');
  });

  it('prints the package version through commander', async () => {
    const program = createProgram();
    const { out } = captureProgram(program);
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };

    await expect(program.parseAsync(['node', 'imcodes', '--version'])).rejects.toMatchObject({
      code: 'commander.version',
      exitCode: 0,
    });

    expect(out.join('').trim()).toBe(pkg.version);
  });

  it('keeps daemon-dependent actions behind explicit subcommands', async () => {
    const program = createProgram();
    const { out } = captureProgram(program);

    await expect(program.parseAsync(['node', 'imcodes', 'start', '--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });

    const help = out.join('');
    expect(help).toContain('Start the daemon via system service');
    expect(help).toContain('--foreground');
  });
});
