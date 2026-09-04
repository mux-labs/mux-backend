import { PrismaClient } from '../src/generated/prisma/client';
import { WalletNetwork, WalletStatus, TransactionStatus } from '../src/generated/prisma/client';

// import { PrismaClient } from '@prisma/client';
// import { WalletNetwork, WalletStatus, TransactionStatus } from '../src/generated/prisma';

const prisma = new PrismaClient({} as any);

async function main() {
  console.log('Seeding demo users and wallets...');

  const demoUsers = [
    {
      authId: 'demo-user-001',
      email: 'alice@demo.mux.dev',
      displayName: 'Alice Demo',
      authProvider: 'DEMO',
    },
    {
      authId: 'demo-user-002',
      email: 'bob@demo.mux.dev',
      displayName: 'Bob Demo',
      authProvider: 'DEMO',
    },
    {
      authId: 'demo-user-003',
      email: 'carol@demo.mux.dev',
      displayName: 'Carol Demo',
      authProvider: 'DEMO',
    },
  ];

  const walletMap: Record<string, { testnet: string; mainnet: string }> = {};

  for (const userData of demoUsers) {
    const user = await prisma.user.upsert({
      where: { authId: userData.authId },
      update: { lastLoginAt: new Date() },
      create: { ...userData, status: 'ACTIVE' },
    });

    // Testnet wallet for each demo user
    const testnetWallet = await prisma.wallet.upsert({
      where: {
        network_publicKey: {
          network: WalletNetwork.TESTNET,
          publicKey: `GDEMO${userData.authId.replace('demo-user-', '').padStart(52, '0')}`,
        },
      },
      update: {},
      create: {
        userId: user.id,
        publicKey: `GDEMO${userData.authId.replace('demo-user-', '').padStart(52, '0')}`,
        encryptedSecret: `encrypted-demo-secret-${userData.authId}`,
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: WalletStatus.ACTIVE,
      },
    });

    // Mainnet wallet for each demo user
    const mainnetWallet = await prisma.wallet.upsert({
      where: {
        network_publicKey: {
          network: WalletNetwork.MAINNET,
          publicKey: `GMAIN${userData.authId.replace('demo-user-', '').padStart(51, '0')}`,
        },
      },
      update: {},
      create: {
        userId: user.id,
        publicKey: `GMAIN${userData.authId.replace('demo-user-', '').padStart(51, '0')}`,
        encryptedSecret: `encrypted-demo-secret-mainnet-${userData.authId}`,
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.MAINNET,
        status: WalletStatus.ACTIVE,
      },
    });

    // Add spending limits for testnet wallet
    await prisma.walletLimit.upsert({
      where: { walletId: testnetWallet.id },
      update: {},
      create: {
        walletId: testnetWallet.id,
        dailyLimit: 10000,
        perTransactionLimit: 1000,
      },
    });

    walletMap[userData.authId] = {
      testnet: testnetWallet.id,
      mainnet: mainnetWallet.id,
    };

    console.log(`  Seeded user: ${userData.displayName} (${user.id})`);
  }

  // Create sample transactions for demo wallets
  console.log('Seeding demo transactions...');
  const userIds = Object.keys(walletMap);
  for (let i = 0; i < userIds.length - 1; i++) {
    const senderAuthId = userIds[i];
    const receiverAuthId = userIds[i + 1];

    const senderWalletId = walletMap[senderAuthId].testnet;
    const receiverWalletId = walletMap[receiverAuthId].testnet;

    // PENDING transaction
    await prisma.transaction.upsert({
      where: { id: `tx-demo-pending-${i}` },
      update: {},
      create: {
        id: `tx-demo-pending-${i}`,
        amount: '100',
        assetType: 'NATIVE',
        senderWalletId,
        receiverWalletId,
        memo: `Demo transfer ${i}`,
        status: TransactionStatus.PENDING,
        idempotencyKey: `demo-tx-pending-${i}`,
      },
    });

    // SUBMITTED transaction
    await prisma.transaction.upsert({
      where: { id: `tx-demo-submitted-${i}` },
      update: {},
      create: {
        id: `tx-demo-submitted-${i}`,
        amount: '50',
        assetType: 'NATIVE',
        senderWalletId,
        receiverWalletId,
        memo: `Demo transfer submitted ${i}`,
        status: TransactionStatus.SUBMITTED,
        submittedAt: new Date(Date.now() - 3600000),
        idempotencyKey: `demo-tx-submitted-${i}`,
      },
    });

    // CONFIRMED transaction
    await prisma.transaction.upsert({
      where: { id: `tx-demo-confirmed-${i}` },
      update: {},
      create: {
        id: `tx-demo-confirmed-${i}`,
        amount: '75',
        assetType: 'NATIVE',
        senderWalletId,
        receiverWalletId,
        memo: `Demo transfer confirmed ${i}`,
        status: TransactionStatus.CONFIRMED,
        submittedAt: new Date(Date.now() - 7200000),
        confirmedAt: new Date(Date.now() - 3600000),
        stellarHash: `demo-hash-confirmed-${i}`,
        stellarLedger: 100000 + i,
        stellarFee: '100',
        idempotencyKey: `demo-tx-confirmed-${i}`,
      },
    });

    console.log(`  Seeded transactions from ${senderAuthId.split('-')[2]} to ${receiverAuthId.split('-')[2]}`);
  }

  console.log('Seeding developer onboarding data...');

  const onboardingDevelopers = [
    {
      email: 'alice@developer.mux.dev',
      name: 'Alice Developer',
      company: 'Mux Labs',
      status: 'ACTIVE',
      projectId: 'project-onboard-alice',
      projectName: 'Alice Starter Project',
      projectDescription: 'Onboarding project for Alice Developer',
      environment: 'development',
      rateLimitRpm: 100,
    },
    {
      email: 'bob@developer.mux.dev',
      name: 'Bob Developer',
      company: 'Mux Labs',
      status: 'ACTIVE',
      projectId: 'project-onboard-bob',
      projectName: 'Bob Starter Project',
      projectDescription: 'Onboarding project for Bob Developer',
      environment: 'staging',
      rateLimitRpm: 250,
    },
  ];

  for (const developerData of onboardingDevelopers) {
    const developer = await prisma.developer.upsert({
      where: { email: developerData.email },
      update: {
        name: developerData.name,
        company: developerData.company,
        status: developerData.status,
        deletedAt: null,
      },
      create: {
        email: developerData.email,
        name: developerData.name,
        company: developerData.company,
        status: developerData.status,
      },
    });

    await prisma.project.upsert({
      where: { id: developerData.projectId },
      update: {
        name: developerData.projectName,
        description: developerData.projectDescription,
        environment: developerData.environment,
        rateLimitRpm: developerData.rateLimitRpm,
        status: 'ACTIVE',
        developerId: developer.id,
      },
      create: {
        id: developerData.projectId,
        name: developerData.projectName,
        description: developerData.projectDescription,
        environment: developerData.environment,
        rateLimitRpm: developerData.rateLimitRpm,
        status: 'ACTIVE',
        developerId: developer.id,
      },
    });

    console.log(`  Seeded developer: ${developer.name} (${developer.id})`);
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
