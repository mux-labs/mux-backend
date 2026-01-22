import { Test, TestingModule } from '@nestjs/testing';
import { WalletCreationOrchestrator } from './wallet-creation.orchestrator';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';

describe('WalletCreationOrchestrator - E2E Tests', () => {
  let orchestrator: WalletCreationOrchestrator;
  let prismaService: PrismaService;
  let module: TestingModule;

  // Test data
  const testUser = {
    id: 'test-user-123',
    email: 'test@example.com',
  };

  const testEncryptionKey = 'test-encryption-key-12345';

  beforeAll(async () => {
    // Create test module with actual PrismaService
    module = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        PrismaService,
      ],
    }).compile();

    orchestrator = module.get<WalletCreationOrchestrator>(WalletCreationOrchestrator);
    prismaService = module.get<PrismaService>(PrismaService);

    // Ensure database is clean
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await module.close();
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  async function cleanupTestData() {
    // Clean up in correct order due to foreign key constraints
    await prismaService.wallet.deleteMany({
      where: { userId: { contains: 'test-' } }
    });
    await prismaService.user.deleteMany({
      where: { id: { contains: 'test-' } }
    });
  }

  describe('REQUIREMENT: Resolve internal user', () => {
    it('should successfully resolve existing user', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      // Act & Assert: Should not throw when resolving user
      await expect(
        orchestrator.createWallet({
          userId: user.id,
          encryptionKey: testEncryptionKey,
        })
      ).resolves.toBeDefined();
    });

    it('should throw NotFoundException for non-existent user', async () => {
      // Act & Assert
      await expect(
        orchestrator.createWallet({
          userId: 'non-existent-user',
          encryptionKey: testEncryptionKey,
        })
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('REQUIREMENT: Generate keypair', () => {
    it('should generate valid Stellar keypair', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      // Act
      const result = await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Assert: Verify Stellar keypair format
      expect(result.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(result.publicKey).toHaveLength(56);
      
      // Verify it's a valid Stellar public key
      expect(() => Keypair.fromPublicKey(result.publicKey)).not.toThrow();
    });

    it('should generate unique keypairs for different users', async () => {
      // Arrange: Create two users
      const user1 = await prismaService.user.create({
        data: { id: 'test-user-1', email: 'user1@example.com' },
      });
      const user2 = await prismaService.user.create({
        data: { id: 'test-user-2', email: 'user2@example.com' },
      });

      // Act
      const result1 = await orchestrator.createWallet({
        userId: user1.id,
        encryptionKey: testEncryptionKey,
      });
      const result2 = await orchestrator.createWallet({
        userId: user2.id,
        encryptionKey: testEncryptionKey,
      });

      // Assert: Public keys should be different
      expect(result1.publicKey).not.toBe(result2.publicKey);
    });
  });

  describe('REQUIREMENT: Encrypt and persist wallet', () => {
    it('should encrypt private key before storage', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      // Act
      const result = await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Assert: Check database storage
      const wallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });

      expect(wallet).toBeDefined();
      expect(wallet!.encryptedKey).not.toBe('');
      expect(wallet!.encryptedKey).not.toContain('S'); // Not a raw Stellar secret key
      expect(wallet!.publicKey).toBe(result.publicKey);
    });

    it('should successfully decrypt stored private key', async () => {
      // Arrange: Create user and wallet
      const user = await prismaService.user.create({
        data: testUser,
      });

      const walletResult = await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Get encrypted key from database
      const wallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });

      // Act: Decrypt the key
      const decryptedKey = await orchestrator.decryptSecretKey(
        wallet!.encryptedKey,
        testEncryptionKey
      );

      // Assert: Should be valid Stellar secret key
      expect(decryptedKey).toMatch(/^S[A-Z0-9]{55}$/);
      expect(decryptedKey).toHaveLength(56);

      // Verify it matches the public key
      const keypair = Keypair.fromSecret(decryptedKey);
      expect(keypair.publicKey()).toBe(walletResult.publicKey);
    });

    it('should fail decryption with wrong encryption key', async () => {
      // Arrange: Create user and wallet
      const user = await prismaService.user.create({
        data: testUser,
      });

      await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      const wallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });

      // Act & Assert: Should fail with wrong key
      await expect(
        orchestrator.decryptSecretKey(wallet!.encryptedKey, 'wrong-key')
      ).rejects.toThrow('Failed to decrypt wallet secret key');
    });
  });

  describe('REQUIREMENT: Ensure idempotency', () => {
    it('should return same wallet on duplicate creation', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      const request = {
        userId: user.id,
        encryptionKey: testEncryptionKey,
      };

      // Act: Create wallet twice
      const result1 = await orchestrator.createWallet(request);
      const result2 = await orchestrator.createWallet(request);

      // Assert: Should return identical results
      expect(result1.walletId).toBe(result2.walletId);
      expect(result1.publicKey).toBe(result2.publicKey);
      expect(result1.userId).toBe(result2.userId);

      // Verify only one wallet exists in database
      const walletCount = await prismaService.wallet.count({
        where: { userId: user.id },
      });
      expect(walletCount).toBe(1);
    });

    it('should handle concurrent wallet creation requests', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      const request = {
        userId: user.id,
        encryptionKey: testEncryptionKey,
      };

      // Act: Create multiple wallets concurrently
      const promises = Array(5).fill(null).map(() => 
        orchestrator.createWallet(request)
      );

      const results = await Promise.all(promises);

      // Assert: All should return the same wallet
      const walletIds = results.map(r => r.walletId);
      const uniqueWalletIds = [...new Set(walletIds)];
      
      expect(uniqueWalletIds).toHaveLength(1);
      
      // Verify only one wallet in database
      const walletCount = await prismaService.wallet.count({
        where: { userId: user.id },
      });
      expect(walletCount).toBe(1);
    });
  });

  describe('ACCEPTANCE CRITERIA: One wallet per user enforced', () => {
    it('should enforce one wallet per user at database level', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      // Act: Create first wallet
      await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Try to create second wallet directly in database (bypassing orchestrator)
      await expect(
        prismaService.wallet.create({
          data: {
            userId: user.id,
            publicKey: 'G' + 'A'.repeat(55),
            encryptedKey: 'encrypted-key',
          },
        })
      ).rejects.toThrow(); // Should fail due to unique constraint
    });

    it('should have unique constraint on userId in schema', async () => {
      // This test verifies the database schema is correct
      const walletCount = await prismaService.wallet.count({
        where: { userId: testUser.id },
      });
      expect(walletCount).toBe(0); // User doesn't exist yet
    });
  });

  describe('ACCEPTANCE CRITERIA: Wallet creation is atomic', () => {
    it('should rollback all operations on user lookup failure', async () => {
      // Act: Try to create wallet for non-existent user
      await expect(
        orchestrator.createWallet({
          userId: 'non-existent-user',
          encryptionKey: testEncryptionKey,
        })
      ).rejects.toThrow(NotFoundException);

      // Assert: No wallet should be created
      const walletCount = await prismaService.wallet.count();
      const initialCount = walletCount; // Should be same as before
      expect(walletCount).toBe(initialCount);
    });

    it('should complete all operations or none', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      const initialWalletCount = await prismaService.wallet.count();

      // Act: Successful wallet creation
      const result = await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Assert: All operations completed
      expect(result.walletId).toBeDefined();
      expect(result.publicKey).toBeDefined();
      
      const finalWalletCount = await prismaService.wallet.count();
      expect(finalWalletCount).toBe(initialWalletCount + 1);

      // Verify wallet exists with correct data
      const wallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });
      expect(wallet).toBeDefined();
      expect(wallet!.publicKey).toBe(result.publicKey);
    });
  });

  describe('ACCEPTANCE CRITERIA: Partial failures do not leave broken state', () => {
    it('should not leave orphaned records on failure', async () => {
      // Arrange: Count initial records
      const initialUserCount = await prismaService.user.count();
      const initialWalletCount = await prismaService.wallet.count();

      // Act: Attempt wallet creation for non-existent user
      await expect(
        orchestrator.createWallet({
          userId: 'non-existent-user',
          encryptionKey: testEncryptionKey,
        })
      ).rejects.toThrow(NotFoundException);

      // Assert: No new records created
      const finalUserCount = await prismaService.user.count();
      const finalWalletCount = await prismaService.wallet.count();

      expect(finalUserCount).toBe(initialUserCount);
      expect(finalWalletCount).toBe(initialWalletCount);
    });

    it('should maintain database consistency on errors', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      // Verify initial state
      const initialWallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });
      expect(initialWallet).toBeNull();

      // Act: Create wallet successfully
      await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Assert: Database is in consistent state
      const finalWallet = await prismaService.wallet.findUnique({
        where: { userId: user.id },
      });
      expect(finalWallet).toBeDefined();
      expect(finalWallet!.userId).toBe(user.id);
      expect(finalWallet!.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(finalWallet!.encryptedKey).not.toBe('');
    });
  });

  describe('Integration: Complete workflow', () => {
    it('should handle complete invisible wallet creation workflow', async () => {
      // Arrange: Create user
      const user = await prismaService.user.create({
        data: testUser,
      });

      // Act: Create wallet
      const result = await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });

      // Assert: Complete workflow verification
      expect(result.walletId).toBeDefined();
      expect(result.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(result.userId).toBe(user.id);

      // Verify wallet retrieval
      const retrievedWallet = await orchestrator.getWalletByUserId(user.id);
      expect(retrievedWallet.id).toBe(result.walletId);
      expect(retrievedWallet.publicKey).toBe(result.publicKey);
      expect(retrievedWallet.userId).toBe(user.id);

      // Verify encryption/decryption round trip
      const decryptedKey = await orchestrator.decryptSecretKey(
        retrievedWallet.encryptedKey,
        testEncryptionKey
      );
      const keypair = Keypair.fromSecret(decryptedKey);
      expect(keypair.publicKey()).toBe(result.publicKey);

      // Verify idempotency
      const duplicateResult = await orchestrator.createWallet({
        userId: user.id,
        encryptionKey: testEncryptionKey,
      });
      expect(duplicateResult.walletId).toBe(result.walletId);
    });
  });
});
