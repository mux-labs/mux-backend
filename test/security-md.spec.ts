import { readFileSync } from 'fs';
import { join } from 'path';

describe('SECURITY.md', () => {
  let content: string;
  let readme: string;

  beforeAll(() => {
    content = readFileSync(join(__dirname, '..', 'SECURITY.md'), 'utf8');
    readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  });

  it('exists and is non-empty', () => {
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('describes a private disclosure channel', () => {
    expect(content).toMatch(/private/i);
  });

  it('states the security contact email in a reporting context', () => {
    const sentences = content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const reportingSentence = sentences.find(
      (s) =>
        s.includes('security@muxprotocol.io') &&
        /\b(report|disclose|disclosure)\b/i.test(s),
    );

    expect(reportingSentence).toBeDefined();
  });

  it('documents a response SLA section', () => {
    expect(content).toMatch(/Response SLA/i);
  });

  it('states a numeric response time for each severity tier', () => {
    const tiers = ['Critical', 'High', 'Medium', 'Low'];
    for (const tier of tiers) {
      const pattern = new RegExp(
        `${tier}[^\\n]*\\d+\\s*(hour|hours|h|day|days|d)\\b`,
        'i',
      );
      expect(content).toMatch(pattern);
    }
  });

  it('reflects the 4-hour critical response commitment from README.md', () => {
    expect(readme).toMatch(/4\s*hours?/i);
    expect(content).toMatch(/Critical[^\n]*4\s*(hour|hours|h)\b/i);
  });

  it('includes safe harbour terms', () => {
    expect(content).toMatch(/Safe Harbor/i);
  });

  it('documents a 90-day disclosure window', () => {
    expect(content).toMatch(/90\s*days?/i);
  });
});
