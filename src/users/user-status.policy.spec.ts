import { userNotFound } from './user-status.policy';

describe('userNotFound', () => {
  it('returns a 404 for a user id that does not resolve', () => {
    const result = userNotFound('missing-user-id');

    expect(result).toBeDefined();
    expect(result.getStatus()).toBe(404);
  });

  it('denies by default and never guesses a resolved user', () => {
    const result = userNotFound('missing-user-id');

    expect(result.getStatus()).toBe(404);
    expect(result.getResponse()).toMatchObject({
      statusCode: 404,
    });
  });
});
