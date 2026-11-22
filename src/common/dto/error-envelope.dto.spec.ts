import {
  redactErrorDetails,
  REDACTED_PLACEHOLDER,
  MAX_DETAIL_MESSAGE_LENGTH,
  SECRET_KEY_DENYLIST,
} from './error-envelope.dto';

describe('redactErrorDetails', () => {
  it('replaces values of denylisted keys (case-insensitive) with the placeholder', () => {
    const details = [
      { field: 'password', message: 'bad password' },
      { field: 'API_KEY', message: 'bad api key' },
      { field: 'Authorization', message: 'bad auth' },
      { field: 'username', message: 'bad username' },
    ];

    const [redacted] = redactErrorDetails(details);

    expect(redacted.webhookSecret).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.field).toBe('body');
    expect(redacted.message).toBe('invalid payload');
  });

  it('masks a Stellar StrKey secret seed in a message', () => {
    const seed = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const details: ErrorDetail[] = [
      { field: 'body.seed', message: `invalid seed ${seed}` },
    ];

    const [redacted] = redactErrorDetails(details);

    expect(redacted.message).not.toContain(seed);
    expect(redacted.message).toContain(REDACTED_PLACEHOLDER);
  });

  it('masks a generated S-secret in a message while keeping non-secret words', () => {
    const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const seed =
      'S' +
      Array.from(
        { length: 55 },
        () => base32Alphabet[Math.floor(Math.random() * base32Alphabet.length)],
      ).join('');
    const details: ErrorDetail[] = [
      { field: 'body.seed', message: `invalid seed ${seed} for account` },
    ];

    const [redacted] = redactErrorDetails(details);

    expect(redacted.message).not.toContain(seed);
    expect(redacted.message).toContain('invalid seed');
    expect(redacted.message).toContain('for account');
  });

  it('returns a benign detail unchanged', () => {
    const details: ErrorDetail[] = [
      { field: 'body.amount', message: 'must be positive' },
    ];

    const [redacted] = redactErrorDetails(details);

    expect(redacted).toEqual({ field: 'body.amount', message: 'must be positive' });
  });

  it('does not mutate the input array or its entries', () => {
    const details: ErrorDetail[] = [
      { field: 'body', message: 'invalid payload', token: 'jwt.token.value' },
    ];
    const snapshot = JSON.parse(JSON.stringify(details));

    const result = redactErrorDetails(details);

    expect(result[0].message).toBe(REDACTED_PLACEHOLDER);
    expect(result[1].message).toBe(REDACTED_PLACEHOLDER);
    expect(result[2].message).toBe(REDACTED_PLACEHOLDER);
    expect(result[3].message).toBe('bad username');
  });

  it('masks Stellar S... StrKey secret seeds appearing in a message', () => {
    const seed = 'S' + 'A'.repeat(55);
    const details = [{ field: 'seed', message: `leaked seed ${seed} here` }];

    const result = redactErrorDetails(details);

    expect(result[0].message).not.toContain(seed);
    expect(result[0].message).toContain(REDACTED_PLACEHOLDER);
  });

  it('truncates message to MAX_DETAIL_MESSAGE_LENGTH characters', () => {
    const longMessage = 'x'.repeat(MAX_DETAIL_MESSAGE_LENGTH + 50);
    const details = [{ field: 'other', message: longMessage }];

    const result = redactErrorDetails(details);

    expect(result[0].message.length).toBe(MAX_DETAIL_MESSAGE_LENGTH);
    expect(result[0].message).toBe(longMessage.slice(0, MAX_DETAIL_MESSAGE_LENGTH));
  });

  it('does not mutate the input array or its entries', () => {
    const seed = 'S' + 'B'.repeat(55);
    const original = [
      { field: 'password', message: `secret ${seed}` },
      { field: 'other', message: 'y'.repeat(MAX_DETAIL_MESSAGE_LENGTH + 10) },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));

    const result = redactErrorDetails(original);

    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result[0]).not.toBe(original[0]);
    expect(result[1]).not.toBe(original[1]);
  });

  it('exposes a non-empty secret key denylist', () => {
    expect(SECRET_KEY_DENYLIST.length).toBeGreaterThan(0);
  });
});
