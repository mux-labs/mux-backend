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
