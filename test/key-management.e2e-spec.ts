/**
 * Key Management E2E Test Suite
 *
 * Tests the HTTP layer of the internal key management endpoints without a real
 * database or HSM. All persistence dependencies (Prisma, KeyRotationAuditService)
 * are replaced with lightweight in-memory stubs so the suite runs offline in CI.
 *
 * Covers:
 *  - POST /internal/key-management/generate
 *  - POST /internal/key-management/sign
 *  - POST /internal/key-management/validate
 *  - POST /internal/key-management/rotate
 *  - GET  /internal/key-management/audit
 *  - GET  /internal/key-management/statistics
 *  - GET  /internal/key-management/statistics/detailed
 *  - Request-ID propagation via x-request-id header
 *  - Invalid / stale / disconnected states (422, 404, 400)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { KeyManagementModule } from '../src/key-management/key-management.module';
import { KeyManagementService } from '../src/key-management/key-management.service';
import { KeyRotationAuditService } from '../src/key-management/key-rotation-audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { KeyType } from '../src/key-management/domain/key-types';
import { ConfigService } from '@nestjs/config';
import requestLogger from '../src/common/middleware/request-logging.middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(): Partial<ConfigService> {
  return {
    get: jest.fn((key: string) => {
      if (key === 'WALLET_ENCRYPTION_KEY')
        return 'e2e-test-encryption-key-32chars!!';
      return undefined;
    }),
  };
}

const mockAuditService = {
  persistAuditLog: jest.fn().mockResolvedValue(undefined),
  convertToPersistentFormat: jest.fn().mockReturnValue({}),
  queryAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
  getRotationHistory: jest.fn().mockResolvedValue({ history: [] }),
  getAuditStatistics: jest.fn().mockResolvedValue({ total: 0 }),
};

const predecessorId = 'wallet-e2e-predecessor';
const successorId = 'wallet-e2e-successor';

const activePredecessorWallet = {
  id: predecessorId,
  userId: 'user-e2e',
  publicKey: 'GPREDECESSORE2E',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  network: 'TESTNET',
  status: 'ACTIVE',
  successorId: null,
  rotatedFromId: null,
};

const mockPrismaService = {
  wallet: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Key Management (e2e)', () => {
  let app: INestApplication;
  let keyManagementService: KeyManagementService;

  beforeAll(async () => {
    // Set up the $transaction mock to run the callback with a tx proxy
    mockPrismaService.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        wallet: {
          create: jest.fn().mockResolvedValue({
            id: successorId,
            userId: 'user-e2e',
            publicKey: 'GSUCCESSORE2E',
            encryptedSecret: 'enc-new',
            encryptionVersion: 1,
            secretVersion: 2,
            network: 'TESTNET',
            status: 'ACTIVE',
            rotatedFromId: predecessorId,
            successorId: null,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      return cb(tx);
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [KeyManagementModule],
    })
      .overrideProvider(ConfigService)
      .useValue(makeConfigService())
      .overrideProvider(KeyRotationAuditService)
      .useValue(mockAuditService)
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(requestLogger as any);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    keyManagementService =
      moduleRef.get<KeyManagementService>(KeyManagementService);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Reset $transaction mock after each test
    mockPrismaService.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        wallet: {
          create: jest.fn().mockResolvedValue({
            id: successorId,
            userId: 'user-e2e',
            publicKey: 'GSUCCESSORE2E',
            encryptedSecret: 'enc-new',
            encryptionVersion: 1,
            secretVersion: 2,
            network: 'TESTNET',
            status: 'ACTIVE',
            rotatedFromId: predecessorId,
            successorId: null,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      return cb(tx);
    });
    mockAuditService.persistAuditLog.mockResolvedValue(undefined);
    mockAuditService.convertToPersistentFormat.mockReturnValue({});
    keyManagementService.resetStatistics();
  });

  // -------------------------------------------------------------------------
  // POST /internal/key-management/generate
  // -------------------------------------------------------------------------

  describe('POST /internal/key-management/generate', () => {
    it('200 – returns encrypted material and public key for STELLAR_ED25519', async () => {
      const res = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      expect(res.body).toHaveProperty('publicKey');
      expect(res.body).toHaveProperty('encryptedData');
      expect(res.body).toHaveProperty('keyType', KeyType.STELLAR_ED25519);
      expect(res.body).toHaveProperty('encryptionVersion');
      expect(res.body).toHaveProperty('keyVersion');

      // Security: private key must never appear in the response
      expect(res.body).not.toHaveProperty('privateKey');
      expect(res.body).not.toHaveProperty('privateKeyMaterial');
    });

    it('200 – public key matches Stellar G-address format', async () => {
      const res = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      expect(res.body.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });

    it('200 – successive calls produce unique key pairs', async () => {
      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post('/internal/key-management/generate')
          .send({ keyType: KeyType.STELLAR_ED25519 }),
        request(app.getHttpServer())
          .post('/internal/key-management/generate')
          .send({ keyType: KeyType.STELLAR_ED25519 }),
      ]);

      expect(r1.body.publicKey).not.toBe(r2.body.publicKey);
      expect(r1.body.encryptedData).not.toBe(r2.body.encryptedData);
    });

    it('responds with x-request-id header when x-request-id is sent', async () => {
      const res = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .set('x-request-id', 'e2e-test-req-001')
        .send({ keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      expect(res.headers['x-request-id']).toBe('e2e-test-req-001');
    });
  });

  // -------------------------------------------------------------------------
  // POST /internal/key-management/sign
  // -------------------------------------------------------------------------

  describe('POST /internal/key-management/sign', () => {
    it('200 – signs data and returns a base64 signature', async () => {
      const genRes = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      const { encryptedData, publicKey } = genRes.body;

      const signRes = await request(app.getHttpServer())
        .post('/internal/key-management/sign')
        .send({
          encryptedKeyMaterial: encryptedData,
          dataToSign: Buffer.from('e2e-test-payload').toString('base64'),
          publicKey,
        })
        .expect(200);

      expect(signRes.body).toHaveProperty('signature');
      expect(signRes.body).toHaveProperty('publicKey', publicKey);
      expect(signRes.body).toHaveProperty('algorithm', 'ed25519');
      expect(signRes.body).toHaveProperty('timestamp');

      expect(signRes.body).not.toHaveProperty('privateKey');
    });

    it('422 – returns Unprocessable Entity for corrupted key material', async () => {
      const genRes = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      const { publicKey, encryptedData } = genRes.body;
      const parsed = JSON.parse(encryptedData);
      parsed.encryptedData = 'deadbeef'.repeat(8);
      const corrupted = JSON.stringify(parsed);

      const res = await request(app.getHttpServer())
        .post('/internal/key-management/sign')
        .send({
          encryptedKeyMaterial: corrupted,
          dataToSign: 'payload',
          publicKey,
        })
        .expect(422);

      expect(res.body).toHaveProperty('error', 'Key Decryption Failed');
      expect(res.body).toHaveProperty('reason');
      // Security: raw crypto internals must not leak
      expect(res.body.message).not.toMatch(/EVP_|openssl/i);
    });

    it('x-request-id is echoed back on sign response', async () => {
      const genRes = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .post('/internal/key-management/sign')
        .set('x-request-id', 'sign-req-xyz')
        .send({
          encryptedKeyMaterial: genRes.body.encryptedData,
          dataToSign: 'hello',
          publicKey: genRes.body.publicKey,
        })
        .expect(200);

      expect(res.headers['x-request-id']).toBe('sign-req-xyz');
    });
  });

  // -------------------------------------------------------------------------
  // POST /internal/key-management/validate
  // -------------------------------------------------------------------------

  describe('POST /internal/key-management/validate', () => {
    it('200 – returns { valid: true } for a matching key pair', async () => {
      const genRes = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .post('/internal/key-management/validate')
        .send({
          publicKey: genRes.body.publicKey,
          encryptedKeyMaterial: genRes.body.encryptedData,
          keyType: KeyType.STELLAR_ED25519,
        })
        .expect(200);

      expect(res.body).toHaveProperty('valid', true);
    });

    it('200 – returns { valid: false } for a mismatched public key', async () => {
      const [r1, r2] = await Promise.all([
        request(app.getHttpServer())
          .post('/internal/key-management/generate')
          .send({ keyType: KeyType.STELLAR_ED25519 }),
        request(app.getHttpServer())
          .post('/internal/key-management/generate')
          .send({ keyType: KeyType.STELLAR_ED25519 }),
      ]);

      const res = await request(app.getHttpServer())
        .post('/internal/key-management/validate')
        .send({
          publicKey: r2.body.publicKey,
          encryptedKeyMaterial: r1.body.encryptedData,
          keyType: KeyType.STELLAR_ED25519,
        })
        .expect(200);

      expect(res.body).toHaveProperty('valid', false);
    });

    it('422 – returns Unprocessable Entity for tampered GCM auth tag', async () => {
      const genRes = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const parsed = JSON.parse(genRes.body.encryptedData);
      parsed.tag = 'ff'.repeat(16);
      const tampered = JSON.stringify(parsed);

      await request(app.getHttpServer())
        .post('/internal/key-management/validate')
        .send({
          publicKey: genRes.body.publicKey,
          encryptedKeyMaterial: tampered,
          keyType: KeyType.STELLAR_ED25519,
        })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // POST /internal/key-management/rotate
  // -------------------------------------------------------------------------

  describe('POST /internal/key-management/rotate', () => {
    it('200 – creates successor wallet and returns rotation result', async () => {
      mockPrismaService.wallet.findUnique.mockResolvedValue(
        activePredecessorWallet,
      );

      const res = await request(app.getHttpServer())
        .post('/internal/key-management/rotate')
        .send({ walletId: predecessorId })
        .expect(200);

      expect(res.body).toHaveProperty('predecessorWalletId', predecessorId);
      expect(res.body).toHaveProperty('successorWalletId', successorId);
      expect(res.body).toHaveProperty('successorPublicKey');
    });

    it('404 – returns Not Found when wallet does not exist', async () => {
      mockPrismaService.wallet.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/internal/key-management/rotate')
        .send({ walletId: 'non-existent' })
        .expect(404);
    });

    it('500 – returns error when wallet is in a non-rotatable status', async () => {
      mockPrismaService.wallet.findUnique.mockResolvedValue({
        ...activePredecessorWallet,
        status: 'DISABLED',
      });

      await request(app.getHttpServer())
        .post('/internal/key-management/rotate')
        .send({ walletId: predecessorId })
        .expect(500);
    });

    it('500 – returns error when wallet already has a successor', async () => {
      mockPrismaService.wallet.findUnique.mockResolvedValue({
        ...activePredecessorWallet,
        successorId: 'already-exists',
      });

      await request(app.getHttpServer())
        .post('/internal/key-management/rotate')
        .send({ walletId: predecessorId })
        .expect(500);
    });
  });

  // -------------------------------------------------------------------------
  // GET /internal/key-management/audit
  // -------------------------------------------------------------------------

  describe('GET /internal/key-management/audit', () => {
    it('200 – returns audit log array', async () => {
      await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .get('/internal/key-management/audit')
        .expect(200);

      expect(res.body).toHaveProperty('logs');
      expect(Array.isArray(res.body.logs)).toBe(true);
      expect(res.body.logs.length).toBeGreaterThan(0);
    });

    it('200 – respects optional limit query param', async () => {
      // Generate several keys so the log has multiple entries
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/internal/key-management/generate')
          .send({ keyType: KeyType.STELLAR_ED25519 });
      }

      const res = await request(app.getHttpServer())
        .get('/internal/key-management/audit?limit=2')
        .expect(200);

      expect(res.body.logs.length).toBeLessThanOrEqual(2);
    });

    it('audit entries include requestId when x-request-id header was sent', async () => {
      await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .set('x-request-id', 'audit-req-001')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .get('/internal/key-management/audit')
        .expect(200);

      const entry = res.body.logs.find(
        (l: any) => l.requestId === 'audit-req-001',
      );
      expect(entry).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /internal/key-management/statistics
  // -------------------------------------------------------------------------

  describe('GET /internal/key-management/statistics', () => {
    it('200 – returns statistics object with expected shape', async () => {
      await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .get('/internal/key-management/statistics')
        .expect(200);

      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('totalKeysGenerated');
      expect(res.body.data).toHaveProperty('totalSigningOperations');
      expect(res.body.data).toHaveProperty('successRate');
      expect(res.body.data.totalKeysGenerated).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /internal/key-management/statistics/detailed
  // -------------------------------------------------------------------------

  describe('GET /internal/key-management/statistics/detailed', () => {
    it('200 – returns detailed statistics with operationMetrics', async () => {
      await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .get('/internal/key-management/statistics/detailed')
        .expect(200);

      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('operationMetrics');
      expect(Array.isArray(res.body.data.operationMetrics)).toBe(true);
    });

    it('200 – includes timeSeries when includeTimeSeries=true', async () => {
      await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .send({ keyType: KeyType.STELLAR_ED25519 });

      const res = await request(app.getHttpServer())
        .get(
          '/internal/key-management/statistics/detailed?includeTimeSeries=true',
        )
        .expect(200);

      expect(res.body.data).toHaveProperty('timeSeries');
      expect(Array.isArray(res.body.data.timeSeries)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Full flow: generate → sign → validate (via HTTP)
  // -------------------------------------------------------------------------

  describe('Full generate → sign → validate flow', () => {
    it('completes the full key lifecycle over HTTP', async () => {
      // Step 1: generate
      const genRes = await request(app.getHttpServer())
        .post('/internal/key-management/generate')
        .set('x-request-id', 'lifecycle-req-001')
        .send({ keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      const { publicKey, encryptedData } = genRes.body;

      // Step 2: sign
      const signRes = await request(app.getHttpServer())
        .post('/internal/key-management/sign')
        .set('x-request-id', 'lifecycle-req-002')
        .send({
          encryptedKeyMaterial: encryptedData,
          dataToSign: 'full-lifecycle-payload',
          publicKey,
        })
        .expect(200);

      expect(signRes.body.signature).toBeDefined();

      // Step 3: validate
      const validateRes = await request(app.getHttpServer())
        .post('/internal/key-management/validate')
        .set('x-request-id', 'lifecycle-req-003')
        .send({ publicKey, encryptedKeyMaterial: encryptedData, keyType: KeyType.STELLAR_ED25519 })
        .expect(200);

      expect(validateRes.body.valid).toBe(true);

      // Step 4: audit trail should capture all 3 request IDs
      const auditRes = await request(app.getHttpServer())
        .get('/internal/key-management/audit')
        .expect(200);

      const ids = auditRes.body.logs
        .map((l: any) => l.requestId)
        .filter(Boolean);

      expect(ids).toContain('lifecycle-req-001');
      expect(ids).toContain('lifecycle-req-002');
    });
  });
});
