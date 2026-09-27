import { HorizonRestBalanceClient } from './horizon-rest-balance.client';
import { HorizonRetryExhaustedError } from './horizon-retry.policy';

/**
 * `axios.get` is replaced by a plain jest mock so no network is touched and the
 * per-attempt behaviour (retry / exhaust) is deterministic.
 */
const mockedGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockedGet(...args) as unknown },
}));
const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function httpError(status: number) {
  return Object.assign(new Error(`status ${status}`), {
    isAxiosError: true,
    response: { status, headers: {} },
  });
}

describe('HorizonRestBalanceClient (#952)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      STELLAR_NETWORK: 'TESTNET',
      STELLAR_HORIZON_TESTNET_URL: 'https://horizon-testnet.stellar.org',
      // Deterministic, zero-delay retry budget for the client tests.
      STELLAR_HORIZON_MAX_RETRIES: '2',
      STELLAR_HORIZON_RETRY_BACKOFF_MS: '0',
      STELLAR_HORIZON_RETRY_JITTER_MS: '0',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('maps a Horizon account payload to the domain snapshot', async () => {
    mockedGet.mockResolvedValue({
      data: {
        last_modified_ledger: 42,
        lastModifiedLedger: 42,
        balances: [
          { asset_type: 'native', balance: '100.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GISSUER',
            balance: '5.0000000',
          },
        ],
      },
    });

    const client = new HorizonRestBalanceClient();
    const snapshot = await client.fetchAccountBalances(ACCOUNT);

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual({
      accountId: ACCOUNT,
      ledger: 42,
      balances: [
        {
          assetType: 'NATIVE',
          assetCode: null,
          assetIssuer: null,
          balance: '100.0000000',
        },
        {
          assetType: 'CREDIT_ALPHANUM4',
          assetCode: 'USDC',
          assetIssuer: 'GISSUER',
          balance: '5.0000000',
        },
      ],
    });
  });

  it('retries transient 5xx and resolves once Horizon recovers', async () => {
    mockedGet.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({
      data: { lastModifiedLedger: 9, balances: [] },
    });

    const client = new HorizonRestBalanceClient();
    await expect(client.fetchAccountBalances(ACCOUNT)).resolves.toEqual({
      accountId: ACCOUNT,
      ledger: 9,
      balances: [],
    });
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('fails closed (typed error, no empty snapshot) when retries are exhausted', async () => {
    mockedGet.mockRejectedValue(httpError(503));

    const client = new HorizonRestBalanceClient();
    const attempt = client.fetchAccountBalances(ACCOUNT);

    await expect(attempt).rejects.toBeInstanceOf(HorizonRetryExhaustedError);
    await expect(attempt).rejects.toMatchObject({
      attempts: 3,
      reason: 'http_503',
    });
    // 1 initial attempt + 2 retries from the env budget.
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it('never retries a permanent 404', async () => {
    mockedGet.mockRejectedValue(httpError(404));

    const client = new HorizonRestBalanceClient();
    await expect(client.fetchAccountBalances(ACCOUNT)).rejects.toThrow(
      'status 404',
    );
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed 200 payload as a permanent failure', async () => {
    mockedGet.mockResolvedValue({ data: { ledger: 7 } });

    const client = new HorizonRestBalanceClient();
    await expect(client.fetchAccountBalances(ACCOUNT)).rejects.toThrow(
      'missing balances',
    );
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsupported network instead of guessing an endpoint', async () => {
    process.env.STELLAR_NETWORK = 'FUTURENET';

    const client = new HorizonRestBalanceClient();
    await expect(client.fetchAccountBalances(ACCOUNT)).rejects.toThrow(
      'unsupported STELLAR_NETWORK',
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('fails closed when mainnet is selected without a mainnet URL', async () => {
    process.env.STELLAR_NETWORK = 'MAINNET';
    delete process.env.STELLAR_HORIZON_MAINNET_URL;

    const client = new HorizonRestBalanceClient();
    await expect(client.fetchAccountBalances(ACCOUNT)).rejects.toThrow(
      'STELLAR_HORIZON_MAINNET_URL is not configured',
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
