/**
 * Minimal stub of the generated Prisma client for Jest.
 * All model accessors return mock objects; tests override them as needed.
 */
const modelProxy = () => ({
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
  count: jest.fn(),
});

class PrismaClient {
  user = modelProxy();
  wallet = modelProxy();
  idempotencyRecord = modelProxy();
  apiKey = modelProxy();
  apiKeyUsage = modelProxy();
  rateLimitRecord = modelProxy();
  project = modelProxy();
  developer = modelProxy();
  payment = modelProxy();
  legacyUser = modelProxy();
  userLimit = modelProxy();
  recoveryRequest = modelProxy();
  walletBalance = modelProxy();
  balanceSyncJob = modelProxy();
  webhookEndpoint = modelProxy();
  webhookDelivery = modelProxy();
  transaction = modelProxy();

  $connect = jest.fn().mockResolvedValue(undefined);
  $disconnect = jest.fn().mockResolvedValue(undefined);
  $transaction = jest.fn().mockImplementation((cb) =>
    typeof cb === 'function' ? cb(this) : Promise.all(cb),
  );
}

module.exports = { PrismaClient };
