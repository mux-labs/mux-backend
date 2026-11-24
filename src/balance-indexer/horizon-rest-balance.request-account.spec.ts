import { HorizonRestBalanceClient } from './horizon-rest-balance.client';

/**
 * Regression tests for `HorizonRestBalanceClient.requestAccount` (#1346).
 *
 * Documented contract: one Horizon GET attempt, kept separate from the retry
 * wrapper so the retried unit is unambiguously a single idempotent read. The
 * method is therefore exercised directly here: it must issue exactly one GET,
 * never a write, never loop on its own, and surface a failure to its caller
 * (the retry wrapper) rather than swallowing it or resolving a partial result.
 *
 * Every axios verb is mocked so a regression that starts writing, or that
 * retries inside the attempt, is caught.
 */
const mockAxios = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
  request: jest.fn(),
};
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args: unknown[]) => mockAxios.get(...args) as unknown,
    post: (...args: unknown[]) => mockAxios.post(...args) as unknown,
    put: (...args: unknown[]) => mockAxios.put(...args) as unknown,
    patch: (...args: unknown[]) => mockAxios.patch(...args) as unknown,
    delete: (...args: unknown[]) => mockAxios.delete(...args) as unknown,
    request: (...args: unknown[]) => mockAxios.request(...args) as unknown,
  },
}));

const BASE_URL = 'https://horizon-testnet.stellar.org';
const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Typed view of the private method under test. */
interface RequestAccountInternals {
  requestAccount(baseUrl: string, accountId: string): Promise<unknown>;
}

/** Shape of the options `requestAccount` passes to `axios.get`. */
interface GetOptions {
  timeout: number;
  validateStatus: (status: number) => boolean;
}

/** The arguments of the `n`th `axios.get` call. */
const getCall = (n = 0) => mockAxios.get.mock.calls[n] as [string, GetOptions];

function httpError(status: number) {
  return Object.assign(new Error(`status ${status}`), {
    isAxiosError: true,
    response: { status, headers: {} },
  });
}

describe('HorizonRestBalanceClient.requestAccount (#1346)', () => {
  let client: HorizonRestBalanceClient;

  const requestAccount = (accountId: string = ACCOUNT) =>
    (client as unknown as RequestAccountInternals).requestAccount(
      BASE_URL,
      accountId,
    );

  const expectNoWrites = () => {
    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(mockAxios.put).not.toHaveBeenCalled();
    expect(mockAxios.patch).not.toHaveBeenCalled();
    expect(mockAxios.delete).not.toHaveBeenCalled();
    expect(mockAxios.request).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    client = new HorizonRestBalanceClient();
  });

  it('issues exactly one GET for the account and maps the payload', async () => {
    mockAxios.get.mockResolvedValue({
      data: {
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

    await expect(requestAccount()).resolves.toEqual({
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

    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    expect(mockAxios.get).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT}`,
      expect.objectContaining({ timeout: 10_000 }),
    );
    expectNoWrites();
  });

  it('URL-encodes the account id so it cannot alter the request path', async () => {
    mockAxios.get.mockResolvedValue({ data: { balances: [] } });

    await requestAccount('../ledgers?x=1');

    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    expect(getCall()[0]).toBe(
      `${BASE_URL}/accounts/${encodeURIComponent('../ledgers?x=1')}`,
    );
  });

  it('only treats 2xx as success, so non-2xx surfaces as an error', async () => {
    mockAxios.get.mockResolvedValue({ data: { balances: [] } });

    await requestAccount();

    const { validateStatus } = getCall()[1];
    expect(validateStatus(200)).toBe(true);
    expect(validateStatus(204)).toBe(true);
    expect(validateStatus(299)).toBe(true);
    expect(validateStatus(199)).toBe(false);
    expect(validateStatus(301)).toBe(false);
    expect(validateStatus(404)).toBe(false);
    expect(validateStatus(503)).toBe(false);
  });

  it.each([503, 429, 404])(
    'makes a single attempt and rethrows the %i error instead of retrying itself',
    async (status) => {
      const failure = httpError(status);
      mockAxios.get.mockRejectedValue(failure);

      await expect(requestAccount()).rejects.toBe(failure);

      expect(mockAxios.get).toHaveBeenCalledTimes(1);
      expectNoWrites();
    },
  );

  it('makes a single attempt and rethrows a transport failure', async () => {
    const reset = Object.assign(new Error('socket hang up'), {
      isAxiosError: true,
      code: 'ECONNRESET',
    });
    mockAxios.get.mockRejectedValue(reset);

    await expect(requestAccount()).rejects.toBe(reset);
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no data', undefined],
    ['no balances', {}],
    ['non-array balances', { balances: 'nope' }],
  ])(
    'throws (never resolves an empty snapshot) on a malformed 200 with %s',
    async (_label, data) => {
      mockAxios.get.mockResolvedValue({ data });

      await expect(requestAccount()).rejects.toThrow(
        'horizon account payload is missing balances',
      );
      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    },
  );
});
