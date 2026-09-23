import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { initProject } from '../../src/app/init-project.js';
import { readProjectInstructions } from '../../src/app/project-instructions.js';

/**
 * What every stage is told about the repository's own rules.
 *
 * Measured 23/09/2026 on a Python service: the repository keeps its rules — how tests run,
 * that the integration conftest TRUNCATEs the database it points at — in a 227-line
 * CLAUDE.md. `init` wrote a 21-line AGENTS.md scaffold, and every stage received the
 * scaffold. The rules existed and no agent could see them.
 */

const DIR = '/repo';

describe('readProjectInstructions', () => {
  it('uses AGENTS.md when the repository wrote one', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${DIR}/AGENTS.md`, '# Rules\n\n- Never touch billing.\n');
    fs.seed(`${DIR}/CLAUDE.md`, '# Other rules\n');

    const read = await readProjectInstructions(fs, DIR);

    expect(read.source).toBe('AGENTS.md');
    expect(read.text).toContain('Never touch billing');
    expect(read.text).not.toContain('Other rules');
  });

  it('falls back to CLAUDE.md when there is no AGENTS.md', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${DIR}/CLAUDE.md`, '# Rules\n\n- Integration tests TRUNCATE the database.\n');

    const read = await readProjectInstructions(fs, DIR);

    expect(read.source).toBe('CLAUDE.md');
    expect(read.text).toContain('TRUNCATE the database');
  });

  it('treats the untouched init scaffold as no instructions, and keeps its validation block', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${DIR}/CLAUDE.md`, '# Rules\n\n- Run tests in the container.\n');
    fs.seed(`${DIR}/.agent-flow/config.yaml`, 'project:\n  name: x\n  type: unknown\n');
    await fs.mkdirp(`${DIR}/.git`);
    await initProject({ fs, projectDir: DIR, force: false }).catch(() => undefined);

    // The scaffold `init` really writes, not a copy of it typed into this test.
    const scaffold = await fs.readFile(`${DIR}/AGENTS.md`);
    expect(scaffold).toContain('agent-flow:begin');

    const read = await readProjectInstructions(fs, DIR);

    expect(read.source).toBe('CLAUDE.md');
    expect(read.text).toContain('Run tests in the container');
    expect(read.text).toContain('agent-flow:begin');
    expect(read.text).not.toContain('Describe the boundaries that must not be crossed');
  });

  it('keeps an AGENTS.md whose owner edited the scaffold', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${DIR}/CLAUDE.md`, '# Claude rules\n');
    await fs.mkdirp(`${DIR}/.git`);
    await initProject({ fs, projectDir: DIR, force: false }).catch(() => undefined);
    const scaffold = await fs.readFile(`${DIR}/AGENTS.md`);
    fs.seed(`${DIR}/AGENTS.md`, scaffold.replace('- Describe the boundaries that must not be crossed.', '- services never import routes.'));

    const read = await readProjectInstructions(fs, DIR);

    expect(read.source).toBe('AGENTS.md');
    expect(read.text).toContain('services never import routes');
  });

  it('says so when there is nothing at all', async () => {
    const read = await readProjectInstructions(new InMemoryFileSystem(), DIR);
    expect(read.source).toBe('none');
    expect(read.text).toBe('No AGENTS.md in this repository.');
  });
});
