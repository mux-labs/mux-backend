import { fresh } from './rate-limit.service';

describe('fresh', () => {
  it('returns the requested quota when it is within the ceiling', () => {
    expect(fresh(1)).toBe(1);
    expect(fresh(10)).toBe(10);
  });

  it('enforces a hard upper bound on any per-developer quota', () => {
    const ceiling = fresh(Number.MAX_SAFE_INTEGER);

    expect(Number.isFinite(ceiling)).toBe(true);
    expect(ceiling).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('does not accept a quota above the ceiling', () => {
    const ceiling = fresh(Number.MAX_SAFE_INTEGER);

    expect(fresh(ceiling)).toBe(ceiling);
    expect(fresh(ceiling + 1)).toBe(ceiling);
  });
});
