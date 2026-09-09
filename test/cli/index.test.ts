import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../../src/index.js';
import { PROJECT_ROOT } from '../../src/util/project-root.js';

const { setupFlowMock } = vi.hoisted(() => ({ setupFlowMock: vi.fn(async () => {}) }));

// The setup command's own module, mocked so the CLI boundary can be exercised
// without running a deployment. Everything asserted below is what the CLI hands
// across that boundary.
vi.mock('../../src/setup/setup-flow.js', () => ({ setupFlow: setupFlowMock }));

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
    expect(memory?.commands.map((command) => command.name()).sort()).toEqual(['list', 'mcp', 'search', 'stats']);
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

  it('upgrade takes a positional [version], not a shadowed --version flag', async () => {
    const program = createProgram();
    const { out } = captureProgram(program);

    await expect(program.parseAsync(['node', 'imcodes', 'upgrade', '--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });

    const help = out.join('');
    expect(help).toContain('Usage: imcodes upgrade');
    // Positional version arg so `imcodes upgrade 2026.5.2477-dev.2586` works.
    expect(help).toContain('[version]');
    expect(help).toContain('--channel');
    // Must NOT be a `--version <ver>` subcommand flag: the program-level
    // .version() shadows it, so it would silently print the version and exit
    // without upgrading (the bug this positional argument replaces).
    expect(help).not.toMatch(/--version <ver>/);
  });
});

/**
 * The public CLI boundary for TURN relay capacity.
 *
 * Every other capacity test calls setupFlow() directly, which leaves the one
 * line that actually connects the flag to the flow untested: deleting
 * `turnRelayCapacity: opts.turnRelayCapacity` from the setup action compiles
 * cleanly, passes the whole setup contract, and makes
 * `imcodes setup --turn-relay-capacity 30000` silently deploy the default 100.
 * These tests drive the real registered command and assert what crosses that
 * boundary.
 */
describe('imcodes setup --turn-relay-capacity', () => {
  beforeEach(() => {
    setupFlowMock.mockClear();
  });

  async function runSetupCommand(...args: string[]): Promise<void> {
    const program = createProgram();
    captureProgram(program);
    await program.parseAsync(['node', 'imcodes', 'setup', '--domain', 'app.example.com', ...args]);
  }

  it('documents the option in help, in allocations and with its real bounds', async () => {
    const program = createProgram();
    const { out } = captureProgram(program);

    await expect(program.parseAsync(['node', 'imcodes', 'setup', '--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });

    const help = out.join('');
    expect(help).toContain('--turn-relay-capacity <allocations>');
    // The question is allocations, not users — the help must say so.
    expect(help).toContain('not users');
    expect(help).toContain('1-30000');
    expect(help).toContain('default: 100');
    // The explicit port overrides stay documented as needing each other.
    expect(help).toContain('--turn-relay-min-port <port>');
    expect(help).toContain('--turn-relay-max-port <port>');
  });

  it.each(['1', '100', '1024', '30000', '30001', 'abc'])(
    'forwards the exact value %s into setupFlow without CLI-side coercion',
    async (value) => {
      await runSetupCommand('--turn-relay-capacity', value);

      expect(setupFlowMock).toHaveBeenCalledTimes(1);
      const [domain, opts] = setupFlowMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(domain).toBe('app.example.com');
      // Verbatim: validation and rejection belong to the shared rule, so the
      // CLI must not clamp, round, or pre-parse the operator's answer.
      expect(opts.turnRelayCapacity).toBe(value);
    },
  );

  it('forwards nothing when the option is omitted, leaving the documented default to setup', async () => {
    await runSetupCommand('--turn');

    const [, opts] = setupFlowMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.turnRelayCapacity).toBeUndefined();
    expect('turnRelayCapacity' in opts).toBe(true);
  });

  it('forwards a capacity alongside the explicit port overrides, so setup can refuse a conflict', async () => {
    await runSetupCommand(
      '--turn-relay-capacity', '1000',
      '--turn-relay-min-port', '49201',
      '--turn-relay-max-port', '50200',
    );

    const [, opts] = setupFlowMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts).toMatchObject({
      turnRelayCapacity: '1000',
      turnRelayMinPort: '49201',
      turnRelayMaxPort: '50200',
    });
  });

  it('rejects the option shape commander itself owns', async () => {
    const program = createProgram();
    captureProgram(program);

    // A value-taking option with no value is a CLI-level error, not a silent
    // fallback to the default.
    await expect(program.parseAsync([
      'node', 'imcodes', 'setup', '--domain', 'app.example.com', '--turn-relay-capacity',
    ])).rejects.toMatchObject({ code: 'commander.optionMissingArgument' });
    expect(setupFlowMock).not.toHaveBeenCalled();
  });

  it('refuses the forwarded out-of-range value at the shared rule, with deployment guidance', async () => {
    // The CLI's job is exact forwarding; this is the other half of that contract
    // — what setup does with '30001' once it arrives.
    const { TURN_RELAY_CAPACITY_REJECTION, parseTurnRelayCapacity, turnRelayCapacityRejectionMessage } =
      await import('../../shared/turn-service.js');

    await runSetupCommand('--turn-relay-capacity', '30001');
    const [, opts] = setupFlowMock.mock.calls[0] as unknown as [string, Record<string, unknown>];

    const parsed = parseTurnRelayCapacity(opts.turnRelayCapacity as string);
    expect(parsed).toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX });
    expect(turnRelayCapacityRejectionMessage(TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX))
      .toMatch(/additional TURN nodes/);
  });
});
