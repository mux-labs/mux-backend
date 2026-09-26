import {
  DATABASE_POOL_ENV,
  MAX_DATABASE_POOL_SIZE,
  MAX_DATABASE_POOL_TIMEOUT_SECONDS,
  applyDatabasePoolConfig,
  buildRuntimeDatabaseUrl,
  databasePoolSnapshot,
  hasDatabasePoolOverrides,
  resolveDatabasePoolConfig,
  validateDatabasePoolEnv,
} from './database-pool.config';

const BASE_URL = 'postgresql://mux:secret@db:5432/mux_db?schema=public';

describe('database pool config (#951)', () => {
  it('is opt-in: nothing configured means the URL is untouched', () => {
    const config = resolveDatabasePoolConfig({});
    expect(config).toEqual({
      connectionLimit: undefined,
      poolTimeoutSeconds: undefined,
      connectTimeoutSeconds: undefined,
    });
    expect(hasDatabasePoolOverrides(config)).toBe(false);
    expect(applyDatabasePoolConfig(BASE_URL, config)).toBe(BASE_URL);
  });

  it('appends configured pool parameters without losing existing ones', () => {
    const url = applyDatabasePoolConfig(BASE_URL, {
      connectionLimit: 20,
      poolTimeoutSeconds: 15,
      connectTimeoutSeconds: 5,
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('schema')).toBe('public');
    expect(parsed.searchParams.get('connection_limit')).toBe('20');
    expect(parsed.searchParams.get('pool_timeout')).toBe('15');
    expect(parsed.searchParams.get('connect_timeout')).toBe('5');
  });

  it('lets an explicit URL parameter win over the env var', () => {
    const url = applyDatabasePoolConfig(`${BASE_URL}&connection_limit=3`, {
      connectionLimit: 20,
    });

    expect(new URL(url).searchParams.get('connection_limit')).toBe('3');
  });

  it('returns an unparseable URL unchanged instead of mangling it', () => {
    expect(applyDatabasePoolConfig('not-a-url', { connectionLimit: 5 })).toBe(
      'not-a-url',
    );
  });

  it('fails closed on malformed or out-of-range values', () => {
    expect(
      validateDatabasePoolEnv({ [DATABASE_POOL_ENV.POOL_SIZE]: 'abc' }),
    ).toHaveLength(1);
    expect(
      validateDatabasePoolEnv({ [DATABASE_POOL_ENV.POOL_SIZE]: '0' }),
    ).toHaveLength(1);
    expect(
      validateDatabasePoolEnv({
        [DATABASE_POOL_ENV.POOL_SIZE]: String(MAX_DATABASE_POOL_SIZE + 1),
      }),
    ).toHaveLength(1);
    expect(
      validateDatabasePoolEnv({
        [DATABASE_POOL_ENV.POOL_TIMEOUT_SECONDS]: String(
          MAX_DATABASE_POOL_TIMEOUT_SECONDS + 1,
        ),
        [DATABASE_POOL_ENV.CONNECT_TIMEOUT_SECONDS]: '1.5',
      }),
    ).toHaveLength(2);
  });

  it('accepts valid values and reports no issues', () => {
    expect(
      validateDatabasePoolEnv({
        [DATABASE_POOL_ENV.POOL_SIZE]: '20',
        [DATABASE_POOL_ENV.POOL_TIMEOUT_SECONDS]: '15',
        [DATABASE_POOL_ENV.CONNECT_TIMEOUT_SECONDS]: '5',
      }),
    ).toEqual([]);
  });

  it('builds the runtime URL from DATABASE_URL only when configured', () => {
    expect(buildRuntimeDatabaseUrl({})).toBeUndefined();
    expect(buildRuntimeDatabaseUrl({ DATABASE_URL: BASE_URL })).toBe(BASE_URL);

    const configured = buildRuntimeDatabaseUrl({
      DATABASE_URL: BASE_URL,
      [DATABASE_POOL_ENV.POOL_SIZE]: '12',
    });
    expect(new URL(configured!).searchParams.get('connection_limit')).toBe(
      '12',
    );
  });

  it('never leaks the URL in the ops snapshot', () => {
    const snapshot = databasePoolSnapshot(resolveDatabasePoolConfig({}));

    expect(snapshot).toEqual({
      connectionLimit: 'engine-default',
      poolTimeoutSeconds: 'engine-default',
      connectTimeoutSeconds: 'engine-default',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
});
