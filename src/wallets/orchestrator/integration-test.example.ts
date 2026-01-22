/**
 * Example usage of the Wallet Creation Orchestrator
 * This demonstrates how to use the orchestrator in practice
 */

import { WalletCreationOrchestrator, CreateWalletRequest } from './wallet-creation.orchestrator';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../encryption/encryption.service';

// Example: Creating a wallet for a new user
async function exampleWalletCreation() {
  const prisma = new PrismaService();
  const encryptionService = new EncryptionService();
  const orchestrator = new WalletCreationOrchestrator(prisma, encryptionService);

  try {
    // First, create a user
    const user = await prisma.user.create({
      data: {
        email: 'user@example.com',
      },
    });

    console.log('Created user:', user.id);

    // Create wallet for the user
    const walletResult = await orchestrator.createWallet({
      userId: user.id,
      encryptionKey: 'super-secret-encryption-key-123',
    });

    console.log('Wallet created successfully:', {
      walletId: walletResult.walletId,
      publicKey: walletResult.publicKey,
      userId: walletResult.userId,
    });

    // Test idempotency - calling again should return the same wallet
    const walletResult2 = await orchestrator.createWallet({
      userId: user.id,
      encryptionKey: 'super-secret-encryption-key-123',
    });

    console.log('Idempotency test - same wallet returned:', 
      walletResult.walletId === walletResult2.walletId);

    // Retrieve wallet by user ID
    const wallet = await orchestrator.getWalletByUserId(user.id);
    console.log('Retrieved wallet:', {
      id: wallet.id,
      publicKey: wallet.publicKey,
      userId: wallet.userId,
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Example: Error handling
async function exampleErrorHandling() {
  const prisma = new PrismaService();
  const encryptionService = new EncryptionService();
  const orchestrator = new WalletCreationOrchestrator(prisma, encryptionService);

  try {
    // Try to create wallet for non-existent user
    await orchestrator.createWallet({
      userId: 'non-existent-user-id',
      encryptionKey: 'encryption-key',
    });
  } catch (error) {
    console.log('Expected error for non-existent user:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

export { exampleWalletCreation, exampleErrorHandling };
