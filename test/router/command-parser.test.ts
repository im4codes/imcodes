import { describe, it, expect } from 'vitest';
import { parseCommand, fromPlatformCommand } from '../../src/router/command-parser.js';

describe('parseCommand()', () => {
  it('returns isCommand=false for plain text', () => {
    const result = parseCommand('hello world');
    expect(result.isCommand).toBe(false);
    expect(result.text).toBe('hello world');
  });

  it('returns isCommand=false for unknown command', () => {
    const result = parseCommand('/unknown arg');
    expect(result.isCommand).toBe(false);
  });

  it('parses /start', () => {
    const result = parseCommand('/start my-project');
    expect(result.isCommand).toBe(true);
    expect(result.command?.name).toBe('start');
    expect(result.command?.args).toEqual(['my-project']);
  });

  it('parses /stop', () => {
    const result = parseCommand('/stop');
    expect(result.isCommand).toBe(true);
    expect(result.command?.name).toBe('stop');
    expect(result.command?.args).toEqual([]);
  });

  it('parses /send with multiple args', () => {
    const result = parseCommand('/send hello world how are you');
    expect(result.isCommand).toBe(true);
    expect(result.command?.name).toBe('send');
    expect(result.command?.rawArgs).toBe('hello world how are you');
    expect(result.command?.args).toEqual(['hello', 'world', 'how', 'are', 'you']);
  });

  it('parses /status', () => {
    expect(parseCommand('/status').command?.name).toBe('status');
  });

  it('parses /list', () => {
    expect(parseCommand('/list').command?.name).toBe('list');
  });

  it('parses /screen with session', () => {
    const result = parseCommand('/screen w1');
    expect(result.command?.name).toBe('screen');
    expect(result.command?.args).toEqual(['w1']);
  });

  it('parses /bind <project>', () => {
    const result = parseCommand('/bind my-project');
    expect(result.command?.name).toBe('bind');
    expect(result.command?.args).toEqual(['my-project']);
  });

  it('parses /register', () => {
    expect(parseCommand('/register').command?.name).toBe('register');
  });

  it('parses /cron', () => {
    expect(parseCommand('/cron').command?.name).toBe('cron');
  });

  it('parses /team', () => {
    expect(parseCommand('/team create myteam').command?.name).toBe('team');
  });

  it('parses /help', () => {
    expect(parseCommand('/help').command?.name).toBe('help');
  });

  it('parses /autofix', () => {
    expect(parseCommand('/autofix --tracker github').command?.name).toBe('autofix');
  });

  it('handles Telegram @botname suffix', () => {
    const result = parseCommand('/start@mybot my-project');
    expect(result.isCommand).toBe(true);
    expect(result.command?.name).toBe('start');
    expect(result.command?.args).toEqual(['my-project']);
  });

  it('trims whitespace', () => {
    const result = parseCommand('  /status  ');
    expect(result.isCommand).toBe(true);
    expect(result.command?.name).toBe('status');
  });

  it('is case-insensitive for command name', () => {
    const result = parseCommand('/START my-project');
    expect(result.command?.name).toBe('start');
  });
});

describe('fromPlatformCommand()', () => {
  it('constructs ChatCommand from pre-parsed platform command', () => {
    const result = fromPlatformCommand('status', [], '/status');
    expect(result.isCommand).toBe(true);
    expect(result.command?.name).toBe('status');
    expect(result.command?.args).toEqual([]);
  });

  it('returns isCommand=false for unknown command', () => {
    const result = fromPlatformCommand('unknown', [], '/unknown');
    expect(result.isCommand).toBe(false);
  });

  it('includes args', () => {
    const result = fromPlatformCommand('send', ['hello', 'world'], '/send hello world');
    expect(result.command?.args).toEqual(['hello', 'world']);
    expect(result.command?.rawArgs).toBe('hello world');
  });
});
