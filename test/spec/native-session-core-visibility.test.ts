import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The platform sessions (macOS .mm, Linux .cc, Windows) are compiled only by the
// platform CI jobs, never by the unit suites. A call from one of them to a member
// the common core keeps private therefore reaches CI as a compile error (it did,
// for SessionCore::ReconcileHeldInput / HoldsInput). This guard fails the same
// mistake locally: every `<instance>.Method(` a platform file makes on the common
// cores must be declared in that class's public section.

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = join(ROOT, 'native');
const COMMON = join(NATIVE, 'remote-desktop-common');

/** Names declared in the public sections of `className` (methods, by `Name(`). */
export function publicMemberNames(header: string, className: string): Set<string> {
  const start = new RegExp(`\\b(class|struct)\\s+${className}\\b[^;{]*\\{`).exec(header);
  if (!start) throw new Error(`class ${className} not found`);
  const bodyStart = start.index + start[0].length;
  const end = header.indexOf('\n};', bodyStart);
  const body = header.slice(bodyStart, end);
  let isPublic = start[1] === 'struct';
  const names = new Set<string>();
  const chunks = body.split(/^\s*(public|private|protected):\s*$/m);
  // split() with a capture group interleaves: [text, label, text, label, ...]
  for (let index = 0; index < chunks.length; index += 1) {
    if (index % 2 === 1) {
      isPublic = chunks[index] === 'public';
      continue;
    }
    if (!isPublic) continue;
    for (const match of chunks[index].matchAll(/(?<![.>\w~])(\w+)\s*\(/g)) names.add(match[1]);
  }
  return names;
}

/** `instance.Method(` calls in `source`. */
export function callsOn(source: string, instance: string, accessor: '.' | '->' = '.'): Set<string> {
  const calls = new Set<string>();
  const access = accessor === '.' ? '\\.' : '->';
  for (const match of source.matchAll(new RegExp(`\\b${instance}${access}(\\w+)\\(`, 'g'))) calls.add(match[1]);
  return calls;
}

function platformSources(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (path !== COMMON && !entry.startsWith('.')) walk(path);
      } else if (/\.(cc|mm|cpp)$/.test(entry)) {
        files.push(path);
      }
    }
  };
  walk(NATIVE);
  return files;
}

const CORES = [
  { instance: 'core_', header: 'session_core.h', className: 'SessionCore' },
  { instance: 'transport_core_', header: 'transport_session_core.h', className: 'TransportSessionCore' },
] as const;

describe('native platform sessions only call the public API of the common cores', () => {
  for (const { instance, header, className } of CORES) {
    it(`every ${instance}.Method() in a platform file is public on ${className}`, () => {
      const exposed = publicMemberNames(readFileSync(join(COMMON, header), 'utf8'), className);
      expect(exposed.size).toBeGreaterThan(5);
      const offenders: string[] = [];
      let checked = 0;
      for (const file of platformSources()) {
        for (const method of callsOn(readFileSync(file, 'utf8'), instance)) {
          checked += 1;
          if (!exposed.has(method)) offenders.push(`${file.slice(ROOT.length + 1)}: ${instance}.${method}()`);
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    });
  }

  it('the macOS worker only calls the public API of MacosRemoteDesktopSession', () => {
    const exposed = publicMemberNames(
      readFileSync(join(NATIVE, 'macos-remote-desktop', 'macos_remote_desktop_session.h'), 'utf8'),
      'MacosRemoteDesktopSession',
    );
    const worker = readFileSync(join(NATIVE, 'macos-remote-desktop', 'macos_remote_desktop_worker_main.mm'), 'utf8');
    const called = callsOn(worker, 'session_', '->');
    expect(called.size).toBeGreaterThan(0);
    expect([...called].filter((method) => !exposed.has(method))).toEqual([]);
    expect(called.has('ReconcileHeldInput') && called.has('HoldsInput')).toBe(true);
  });

  it('sees the held-input reconcile that the platform sessions rely on as public', () => {
    const exposed = publicMemberNames(readFileSync(join(COMMON, 'session_core.h'), 'utf8'), 'SessionCore');
    expect(exposed.has('ReconcileHeldInput')).toBe(true);
    expect(exposed.has('HoldsInput')).toBe(true);
  });

  it('would have caught the private-member call (counterexample on a fixture header)', () => {
    const header = [
      'class Core {',
      ' public:',
      '  void Stop();',
      ' private:',
      '  bool HoldsInput() const noexcept { return held_.Any(); }',
      '};',
    ].join('\n');
    const exposed = publicMemberNames(header, 'Core');
    expect(exposed.has('Stop')).toBe(true);
    expect(exposed.has('HoldsInput')).toBe(false);
    expect([...callsOn('if (core_.HoldsInput()) core_.Stop();', 'core_')].filter((m) => !exposed.has(m)))
      .toEqual(['HoldsInput']);
  });
});
