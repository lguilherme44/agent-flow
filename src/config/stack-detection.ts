import { parse as parseYaml } from 'yaml';
import type { FileSystem } from '../ports/file-system.js';

/**
 * Stack detection (§7).
 *
 * This is the one file allowed to mention a framework by name, and its output is
 * deliberately thin: a label, some suggested commands, some paths. Nothing here
 * changes how the orchestrator behaves — the label is passed to agents as
 * context, never branched on (§58). Stack-specific *rules* belong in the project
 * config and AGENTS.md, where a human wrote them.
 *
 * Commands are read out of the repository rather than assumed. Suggesting
 * `npm run lint` to a project with no lint script would create a verification
 * step that fails for a reason that has nothing to do with the change.
 */

export interface DetectedStack {
  readonly type: string;
  readonly name: string;
  readonly commands: {
    install?: string;
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
  };
  readonly paths: { source: string[]; tests: string[] };
}

interface Marker {
  readonly file: string;
  readonly type: string;
}

/** Order matters: the first match wins. */
const MARKERS: readonly Marker[] = [
  { file: 'pubspec.yaml', type: 'flutter' },
  { file: 'package.json', type: 'node' },
  { file: 'pyproject.toml', type: 'python' },
  { file: 'go.mod', type: 'go' },
  { file: 'Cargo.toml', type: 'rust' },
];

const SOURCE_CANDIDATES = ['src', 'lib', 'app', 'internal', 'cmd'];
const TEST_CANDIDATES = ['test', 'tests', '__tests__', 'spec'];

export async function detectStack(fs: FileSystem, projectDir: string): Promise<DetectedStack> {
  const directoryName = projectDir.split('/').filter(Boolean).at(-1) ?? 'project';

  let type = 'unknown';
  for (const marker of MARKERS) {
    if (await fs.exists(`${projectDir}/${marker.file}`)) {
      type = marker.type;
      break;
    }
  }

  const detected = await detectFor(type, fs, projectDir, directoryName);

  return {
    ...detected,
    paths: {
      source: await existingDirs(fs, projectDir, SOURCE_CANDIDATES),
      tests: await existingDirs(fs, projectDir, TEST_CANDIDATES),
    },
  };
}

async function detectFor(
  type: string,
  fs: FileSystem,
  projectDir: string,
  directoryName: string,
): Promise<Omit<DetectedStack, 'paths'>> {
  switch (type) {
    case 'node':
      return detectNode(fs, projectDir, directoryName);
    case 'flutter':
      return {
        type,
        name: (await readYamlName(fs, `${projectDir}/pubspec.yaml`)) ?? directoryName,
        commands: {
          install: 'flutter pub get',
          lint: 'flutter analyze',
          test: 'flutter test',
        },
      };
    case 'python':
      return { type, name: directoryName, commands: { test: 'pytest' } };
    case 'go':
      return {
        type,
        name: (await readGoModuleName(fs, `${projectDir}/go.mod`)) ?? directoryName,
        commands: { lint: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' },
      };
    case 'rust':
      return {
        type,
        name: directoryName,
        commands: { lint: 'cargo clippy', test: 'cargo test', build: 'cargo build' },
      };
    default:
      // Unrecognised is a valid outcome: `init` still produces a usable file,
      // with empty commands the user can fill in.
      return { type: 'unknown', name: directoryName, commands: {} };
  }
}

async function detectNode(
  fs: FileSystem,
  projectDir: string,
  directoryName: string,
): Promise<Omit<DetectedStack, 'paths'>> {
  const manager = await packageManager(fs, projectDir);
  const commands: DetectedStack['commands'] = {
    install: manager === 'npm' ? 'npm install' : `${manager} install`,
  };

  let name = directoryName;

  try {
    const manifest = JSON.parse(await fs.readFile(`${projectDir}/package.json`)) as {
      name?: string;
      scripts?: Record<string, string>;
    };

    if (manifest.name) name = manifest.name;

    // Only scripts that exist. An invented command is worse than a missing one.
    for (const script of ['lint', 'typecheck', 'test', 'build'] as const) {
      if (manifest.scripts?.[script]) commands[script] = `${manager} run ${script}`;
    }
  } catch {
    // A malformed manifest is a reason to fall back, not to fail `init`.
  }

  return { type: 'node', name, commands };
}

async function packageManager(fs: FileSystem, projectDir: string): Promise<string> {
  if (await fs.exists(`${projectDir}/pnpm-lock.yaml`)) return 'pnpm';
  if (await fs.exists(`${projectDir}/yarn.lock`)) return 'yarn';
  if (await fs.exists(`${projectDir}/bun.lockb`)) return 'bun';
  return 'npm';
}

async function readYamlName(fs: FileSystem, path: string): Promise<string | undefined> {
  try {
    const parsed = parseYaml(await fs.readFile(path)) as { name?: string } | null;
    return parsed?.name;
  } catch {
    return undefined;
  }
}

async function readGoModuleName(fs: FileSystem, path: string): Promise<string | undefined> {
  try {
    const match = /^module\s+(\S+)/m.exec(await fs.readFile(path));
    return match?.[1]?.split('/').at(-1);
  } catch {
    return undefined;
  }
}

async function existingDirs(
  fs: FileSystem,
  projectDir: string,
  candidates: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    const stat = await fs.stat(`${projectDir}/${candidate}`);
    if (stat?.isDirectory === true) found.push(candidate);
  }
  return found;
}
