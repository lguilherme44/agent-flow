import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArtifactReader } from './ArtifactReader';

describe('ArtifactReader', () => {
  const SAMPLE_MARKDOWN = `# Specification Document

## Architecture Impact
This change modifies the core execution pipeline.

## Risks & Security
* Risk 1: High latency
* Risk 2: Token overflow

## Acceptance Criteria
1. First criteria
2. Second criteria

> [!NOTE]
> Important operational detail.

\`\`\`typescript
const greeting = "hello world";
\`\`\`

Here is \`inline_code\` and **bold text**.
`;

  it('renders structured markdown with headings and lists', () => {
    render(<ArtifactReader content={SAMPLE_MARKDOWN} name="sdd" label="SDD" />);

    expect(screen.getByText('Specification Document')).toBeInTheDocument();
    expect(screen.getByText('Architecture Impact')).toBeInTheDocument();
    expect(screen.getByText('Risks & Security')).toBeInTheDocument();
    expect(screen.getByText('Acceptance Criteria')).toBeInTheDocument();
    expect(screen.getByText('Risk 1: High latency')).toBeInTheDocument();
    expect(screen.getByText('First criteria')).toBeInTheDocument();
    expect(screen.getByText('inline_code')).toBeInTheDocument();
    expect(screen.getByText('bold text')).toBeInTheDocument();
  });

  it('highlights key architectural sections', () => {
    render(<ArtifactReader content={SAMPLE_MARKDOWN} name="sdd" label="SDD" />);

    const badges = screen.getAllByText('Key Section');
    expect(badges.length).toBeGreaterThan(0);
  });

  it('switches between Rendered and Raw view modes', async () => {
    render(<ArtifactReader content={SAMPLE_MARKDOWN} name="sdd" label="SDD" />);

    const rawBtn = screen.getByRole('button', { name: /raw/i });
    expect(rawBtn).toBeInTheDocument();

    await userEvent.click(rawBtn);

    // In Raw mode, the pre block contains full markdown source
    expect(screen.getByText(/# Specification Document/)).toBeInTheDocument();

    const renderedBtn = screen.getByRole('button', { name: /rendered/i });
    await userEvent.click(renderedBtn);

    expect(screen.getByText('Specification Document')).toBeInTheDocument();
  });

  it('provides copy content button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });

    render(<ArtifactReader content={SAMPLE_MARKDOWN} name="sdd" label="SDD" />);

    const copyBtn = screen.getByRole('button', { name: /copy content/i });
    await userEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith(SAMPLE_MARKDOWN);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('supports expand toggle when provided', async () => {
    const onToggle = vi.fn();
    render(
      <ArtifactReader
        content={SAMPLE_MARKDOWN}
        name="sdd"
        label="SDD"
        isExpanded={false}
        onToggleExpand={onToggle}
      />,
    );

    const expandBtn = screen.getByRole('button', { name: /expand reader/i });
    await userEvent.click(expandBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
