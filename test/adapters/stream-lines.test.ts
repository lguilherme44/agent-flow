import { describe, it, expect } from 'vitest';
import { activityText, jsonLine, lineSplitter } from '../../src/adapters/runners/stream-lines.js';

describe('lineSplitter', () => {
  it('hands over whole lines however the pipe split them, CRLF included', () => {
    const lines: string[] = [];
    const splitter = lineSplitter((line) => lines.push(line));

    splitter.push('{"a":');
    splitter.push('1}\r\n{"b"');
    splitter.push(':2}\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);

    // The last line has no newline: it arrives when the process ends, and only once.
    splitter.flush();
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('jsonLine', () => {
  it('reads an object and nothing else', () => {
    expect(jsonLine(' {"type":"x"} ')).toEqual({ type: 'x' });
    expect(jsonLine('[1,2]')).toBeUndefined();
    expect(jsonLine('{not json')).toBeUndefined();
    expect(jsonLine('Reading prompt from stdin...')).toBeUndefined();
  });
});

describe('activityText', () => {
  it('cuts a long message and says so', () => {
    const text = activityText(`  ${'x'.repeat(250)}  `);
    expect(text).toBe(`${'x'.repeat(200)}…`);
    expect(activityText(' short ')).toBe('short');
  });
});
