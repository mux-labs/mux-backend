import {
  DatabasePoolConfig,
  databasePoolSnapshot,
  resolveDatabasePoolConfig,
} from './database-pool.config';

/**
 * Regression coverage for databasePoolSnapshot (#1322): the ops snapshot is
 * secret-free — only resolved sizing (or the engine default) is exposed.
 */
describe('databasePoolSnapshot', () => {
  it('reports resolved numeric sizing and engine defaults for unset values', () => {
    const config = resolveDatabasePoolConfig({
      DATABASE_POOL_SIZE: '20',
      DATABASE_POOL_TIMEOUT_SECONDS: '15',
    });

    expect(databasePoolSnapshot(config)).toEqual({
      connectionLimit: 20,
      poolTimeoutSeconds: 15,
      connectTimeoutSeconds: 'engine-default',
    });
    expect(databasePoolSnapshot({})).toEqual({
      connectionLimit: 'engine-default',
      poolTimeoutSeconds: 'engine-default',
      connectTimeoutSeconds: 'engine-default',
    });
  });

  it('never includes the URL, user, password or host, even if present on the input', () => {
    const secretBearingConfig = {
      connectionLimit: 10,
      poolTimeoutSeconds: 5,
      connectTimeoutSeconds: 3,
      url: 'postgresql://mux-user:s3cr3t@db.internal:5432/mux_db',
      user: 'mux-user',
      password: 's3cr3t',
      host: 'db.internal',
    } as DatabasePoolConfig;

    const snapshot = databasePoolSnapshot(secretBearingConfig);

    expect(Object.keys(snapshot).sort()).toEqual([
      'connectTimeoutSeconds',
      'connectionLimit',
      'poolTimeoutSeconds',
    ]);
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      'postgresql://',
      'mux-user',
      's3cr3t',
      'db.internal',
      'url',
      'password',
      'host',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
