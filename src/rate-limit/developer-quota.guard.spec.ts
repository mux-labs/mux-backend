import { resolveDeveloperId } from './developer-quota.guard';

describe('resolveDeveloperId', () => {
  it('returns the developer id from the authenticated API key context', () => {
    const request = {
      apiKey: { developer: { id: 'dev-from-key' } },
    } as any;

    expect(resolveDeveloperId(request)).toBe('dev-from-key');
  });

  it('does not fall back to a client-supplied developerId when the API key is missing', () => {
    const request = {
      developerId: 'attacker-supplied',
    } as any;

    expect(resolveDeveloperId(request)).toBeUndefined();
  });

  it('does not fall back to a client-supplied developerId when the key has no developer', () => {
    const request = {
      apiKey: {},
      developerId: 'attacker-supplied',
    } as any;

    expect(resolveDeveloperId(request)).toBeUndefined();
  });

  it('ignores a client-supplied developerId even when a valid key developer is present', () => {
    const request = {
      apiKey: { developer: { id: 'dev-from-key' } },
      developerId: 'attacker-supplied',
    } as any;

    expect(resolveDeveloperId(request)).toBe('dev-from-key');
  });
});
