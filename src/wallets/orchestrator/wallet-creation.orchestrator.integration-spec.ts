import { Test, TestingModule } from '@nestjs/testing';
import { WalletCreationOrchestrator } from './wallet-creation.orchestrator';
import { PrismaService } from '../../prisma/prisma.service';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../app.module';

describe('Wallet Creation Orchestrator - API Integration Tests', () => {
  let app: INestApplication;
  let prismaService: PrismaService;
  let orchestrator: WalletCreationOrchestrator;

  const testUser = {
    email: 'integration-test@example.com',
  };

  const testEncryptionKey = 'integration-test-key-12345';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    orchestrator = moduleFixture.get<WalletCreationOrchestrator>(WalletCreationOrchestrator);

    await app.init();
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  async function cleanupTestData() {
    await prismaService.wallet.deleteMany({
      where: { user: { email: { contains: 'integration-test' } } }
    });
    await prismaService.user.deleteMany({
      where: { email: { contains: 'integration-test' } }
    });
  }

  describe('API Endpoints - Complete Workflow Tests', () => {
    it('should create user and wallet through API endpoints', async () => {
      // Step 1: Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;
      expect(user.id).toBeDefined();
      expect(user.email).toBe(testUser.email);

      // Step 2: Create wallet for user
      const walletResponse = await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      const wallet = walletResponse.body;
      expect(wallet.walletId).toBeDefined();
      expect(wallet.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(wallet.userId).toBe(user.id);

      // Step 3: Retrieve wallet by user ID
      const retrieveResponse = await request(app.getHttpServer())
        .get(`/wallets/user/${user.id}`)
        .expect(200);

      const retrievedWallet = retrieveResponse.body;
      expect(retrievedWallet.id).toBe(wallet.walletId);
      expect(retrievedWallet.publicKey).toBe(wallet.publicKey);
      expect(retrievedWallet.userId).toBe(user.id);
    });

    it('should demonstrate idempotency through API', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Create wallet twice
      const walletResponse1 = await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      const walletResponse2 = await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      // Should return same wallet
      expect(walletResponse1.body.walletId).toBe(walletResponse2.body.walletId);
      expect(walletResponse1.body.publicKey).toBe(walletResponse2.body.publicKey);

      // Verify only one wallet in database
      const walletCount = await prismaService.wallet.count({
        where: { userId: user.id },
      });
      expect(walletCount).toBe(1);
    });

    it('should handle invalid user ID gracefully', async () => {
      const response = await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: 'invalid-user-id',
          encryptionKey: testEncryptionKey,
        })
        .expect(404);

      expect(response.body.message).toContain('not found');
    });

    it('should validate request body', async () => {
      // Missing userId
      await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          encryptionKey: testEncryptionKey,
        })
        .expect(400);

      // Missing encryptionKey
      await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: 'some-user-id',
        })
        .expect(400);
    });
  });

  describe('Performance and Load Tests', () => {
    it('should handle concurrent wallet creation requests', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Create 10 concurrent wallet creation requests
      const promises = Array(10).fill(null).map(() =>
        request(app.getHttpServer())
          .post('/wallets/create-user-wallet')
          .send({
            userId: user.id,
            encryptionKey: testEncryptionKey,
          })
      );

      const responses = await Promise.all(promises);

      // All should succeed
      responses.forEach(response => {
        expect(response.status).toBe(201);
        expect(response.body.walletId).toBeDefined();
      });

      // All should return the same wallet
      const walletIds = responses.map(r => r.body.walletId);
      const uniqueWalletIds = [...new Set(walletIds)];
      expect(uniqueWalletIds).toHaveLength(1);

      // Verify only one wallet in database
      const walletCount = await prismaService.wallet.count({
        where: { userId: user.id },
      });
      expect(walletCount).toBe(1);
    });

    it('should complete wallet creation within reasonable time', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Measure wallet creation time
      const startTime = Date.now();
      
      await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within 1 second (generous for test environment)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Security Tests', () => {
    it('should never expose private keys in API responses', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Create wallet
      const walletResponse = await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      const wallet = walletResponse.body;

      // Should not contain private key
      expect(wallet.encryptedKey).toBeUndefined();
      expect(wallet.secretKey).toBeUndefined();
      expect(wallet.privateKey).toBeUndefined();

      // Retrieve wallet - also should not expose private key
      const retrieveResponse = await request(app.getHttpServer())
        .get(`/wallets/user/${user.id}`)
        .expect(200);

      const retrievedWallet = retrieveResponse.body;
      expect(retrievedWallet.encryptedKey).toBeUndefined();
      expect(retrievedWallet.secretKey).toBeUndefined();
      expect(retrievedWallet.privateKey).toBeUndefined();
    });

    it('should store encrypted keys in database', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Create wallet
      await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      // Check database directly
      const wallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });

      expect(wallet).toBeDefined();
      expect(wallet!.encryptedKey).not.toBe('');
      expect(wallet!.encryptedKey).not.toContain('S'); // Not raw Stellar secret
      expect(wallet!.encryptedKey.length).toBeGreaterThan(20); // Encrypted data
    });
  });

  describe('Data Integrity Tests', () => {
    it('should maintain referential integrity', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Create wallet
      await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      // Verify wallet is linked to correct user
      const wallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
        include: { user: true },
      });

      expect(wallet).toBeDefined();
      expect(wallet!.user.id).toBe(user.id);
      expect(wallet!.user.email).toBe(testUser.email);

      // Delete user - should cascade delete wallet
      await request(app.getHttpServer())
        .delete(`/users/${user.id}`)
        .expect(200);

      // Wallet should also be deleted
      const deletedWallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });
      expect(deletedWallet).toBeNull();
    });

    it('should enforce unique constraints at database level', async () => {
      // Create user
      const userResponse = await request(app.getHttpServer())
        .post('/users')
        .send(testUser)
        .expect(201);

      const user = userResponse.body;

      // Create wallet
      const walletResponse = await request(app.getHttpServer())
        .post('/wallets/create-user-wallet')
        .send({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
        .expect(201);

      const wallet = walletResponse.body;

      // Try to create another wallet with same public key directly in database
      await expect(
        prismaService.wallet.create({
          data: {
            userId: 'another-user-id',
            publicKey: wallet.publicKey, // Same public key
            encryptedKey: 'another-encrypted-key',
          },
        })
      ).rejects.toThrow();
    });
  });
});
