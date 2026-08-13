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
      return detectPython(fs, projectDir, directoryName);
    case 'go':
      return {
        type,
        name: (await readGoModuleName(fs, `${projectDir}/go.mod`)) ?? directoryName,
        commands: { lint: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' },
      };
    case 'rust':
      return {
        type,
        name: (await readTomlName(fs, `${projectDir}/Cargo.toml`, 'package')) ?? directoryName,
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
  // The runner for `run <script>` is still the plain manager name; only the
  // install form is lockfile-aware.
  const manager = await packageManager(fs, projectDir);
  const commands: DetectedStack['commands'] = {
    install: await installCommand(fs, projectDir, manager),
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

/**
 * The install command a **new** project is given, lockfile-respecting where the
 * package manager has such a form (§8.4).
 *
 * `npm install` rewrites `package-lock.json` whenever the lock is even slightly
 * out of date with `package.json`. That is a tracked modification, so it fails
 * the post-setup cleanliness assertion, so worktree mode refuses every task in
 * the project — the gate working correctly, over a wall most Node projects walk
 * into on their first run. `npm ci` respects the lock, matches what CI does, and
 * fails loudly when the lock is genuinely stale rather than quietly editing it.
 *
 * Only where the manager actually has a lockfile-respecting form, and only where
 * the lockfile is present to respect: `npm ci` requires `package-lock.json` and
 * refuses without one, so a project that has none keeps `npm install`. The other
 * three managers keep their plain form here — their frozen-lockfile flags differ
 * per major version, and §23's rule about unprobed claims applies to a flag as
 * much as to a Git version. Naming one this milestone has not verified would be
 * exactly the kind of assertion the Findings document exists because of.
 *
 * **This changes what `init` writes for a new project and nothing else.** An
 * existing `.agent-flow/config.yaml` is never rewritten (§8.4), so no project
 * silently changes how it installs.
 */
async function installCommand(
  fs: FileSystem,
  projectDir: string,
  manager: string,
): Promise<string> {
  if (manager === 'npm' && (await fs.exists(`${projectDir}/package-lock.json`))) return 'npm ci';
  return `${manager} install`;
}

/** Which package manager this project uses, from its lockfile. */
async function packageManager(fs: FileSystem, projectDir: string): Promise<string> {
  if (await fs.exists(`${projectDir}/pnpm-lock.yaml`)) return 'pnpm';
  if (await fs.exists(`${projectDir}/yarn.lock`)) return 'yarn';
  if (await fs.exists(`${projectDir}/bun.lockb`)) return 'bun';
  return 'npm';
}

/**
 * Python, read the way Node is read.
 *
 * The manifest was already parsed to identify the stack; not looking at what it
 * declares was the gap. It matters more than a wrong name in a config file: the
 * set of commands here becomes the set of validation ids a plan may cite, and a
 * plan whose only id is `test` will happily carry acceptance criteria that
 * `pytest` cannot check. A live plan review caught exactly that.
 *
 * Nothing is invented. A linter appears only if the project declares one — the
 * Node detector's rule, for the same reason: a command that does not exist is
 * worse than a missing one, because tasks get planned against it.
 */
async function detectPython(
  fs: FileSystem,
  projectDir: string,
  directoryName: string,
): Promise<Omit<DetectedStack, 'paths'>> {
  // A bare `pytest` reaches whatever is on PATH, which need not be the
  // environment the project pins — the same reasoning as `packageManager`.
  const prefix = (await fs.exists(`${projectDir}/uv.lock`))
    ? 'uv run '
    : (await fs.exists(`${projectDir}/poetry.lock`))
      ? 'poetry run '
      : '';

  const commands: DetectedStack['commands'] = { test: `${prefix}pytest` };
  let name = directoryName;

  try {
    const manifest = await fs.readFile(`${projectDir}/pyproject.toml`);

    name = readNameFrom(manifest, 'project') ?? directoryName;

    if (/\bruff\b/.test(manifest)) commands.lint = `${prefix}ruff check .`;
    if (/\bmypy\b/.test(manifest)) commands.typecheck = `${prefix}mypy .`;
    else if (/\bpyright\b/.test(manifest)) commands.typecheck = `${prefix}pyright`;
  } catch {
    // An unreadable manifest is a reason to fall back, not to fail `init`.
  }

  return { type: 'python', name, commands };
}

/**
 * The `name` of one TOML table, without a TOML parser.
 *
 * Scoped to the table deliberately: `name = ` also appears under
 * `[dependencies]` entries, and the first match in the file is not necessarily
 * the package's own.
 */
function readNameFrom(source: string, table: string): string | undefined {
  const lines = source.split('\n');
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[')) {
      inTable = trimmed === `[${table}]`;
      continue;
    }

    if (!inTable) continue;

    const match = /^name\s*=\s*["']([^"']+)["']/.exec(trimmed);
    if (match?.[1] !== undefined) return match[1];
  }

  return undefined;
}

async function readTomlName(
  fs: FileSystem,
  path: string,
  table: string,
): Promise<string | undefined> {
  try {
    return readNameFrom(await fs.readFile(path), table);
  } catch {
    return undefined;
  }
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
