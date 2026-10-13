import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLOW_GUIDE,
  FLOW_GUIDES,
  findFlowGuide,
  flowGuideKeys,
  flowGuideUri,
} from '../../src/core/flow-guides.js';

/**
 * The registry of operator guides (`agent-flow instructions`).
 *
 * One static list that every channel serves — the CLI today, an MCP tool and an MCP
 * resource later. These tests pin the properties those channels rely on without reading
 * a file: a key names exactly one guide, and a guide's URI is derived from its key.
 */
describe('the flow guide registry', () => {
  it('ships the seven flows an operator needs, overview first', () => {
    expect(flowGuideKeys()).toEqual([
      'overview',
      'feature',
      'gate',
      'blocked',
      'recover',
      'done',
      'device-proof',
    ]);
    expect(DEFAULT_FLOW_GUIDE).toBe('overview');
  });

  it('gives every guide a unique key', () => {
    const keys = FLOW_GUIDES.map((guide) => guide.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('addresses every guide as agent-flow://flows/<key>', () => {
    for (const guide of FLOW_GUIDES) {
      expect(guide.uri).toBe(`agent-flow://flows/${guide.key}`);
      expect(flowGuideUri(guide.key)).toBe(guide.uri);
    }
  });

  it('names a Markdown file per guide, after its key', () => {
    for (const guide of FLOW_GUIDES) expect(guide.file).toBe(`${guide.key}.md`);
  });

  it('describes every guide in one line', () => {
    for (const guide of FLOW_GUIDES) {
      expect(guide.name.trim()).not.toBe('');
      expect(guide.description.trim()).not.toBe('');
      expect(guide.description).not.toContain('\n');
    }
  });

  it('finds a guide by key and nothing for a key it does not have', () => {
    expect(findFlowGuide('gate')?.uri).toBe('agent-flow://flows/gate');
    expect(findFlowGuide('nope')).toBeUndefined();
    // Not a prefix match: a near miss is an unknown key, not the closest guide.
    expect(findFlowGuide('gat')).toBeUndefined();
    expect(findFlowGuide('')).toBeUndefined();
  });
});
