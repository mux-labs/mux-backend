import { PrismaClient } from '../src/generated/prisma/client';
import { WalletNetwork, WalletStatus, TransactionStatus } from '../src/generated/prisma/client';
import {
  assertSeedAllowed,
  SeedNotAllowedError,
} from '../src/common/seed/seed-safety';

// import { PrismaClient } from '@prisma/client';
// import { WalletNetwork, WalletStatus, TransactionStatus } from '../src/generated/prisma';

const prisma = new PrismaClient({} as any);

/**
 * Demo public keys are padded, obviously-fake `G` addresses. They are not
 * valid Stellar accounts and their `encryptedSecret` is a literal placeholder,
 * so a seeded wallet can never sign. That is exactly why the seed must never
 * run outside a local database — see `src/common/seed/seed-safety.ts` (#928).
 */
function demoPublicKey(prefix: string, authId: string, padTo: number): string {
  return `${prefix}${authId.replace('demo-user-', '').padStart(padTo, '0')}`;
}

async function main() {
  // Fail-closed preflight (#928): refuse to seed production, mainnet, or a
  // non-local database. Runs before a single row is written.
  const preflight = assertSeedAllowed();

  if (preflight.includeMainnet) {
    console.log(
      'WARNING: PRISMA_SEED_INCLUDE_MAINNET=true — creating demo MAINNET wallet rows. ' +
        'These hold placeholder secrets and are for local UI testing only.',
    );
  }

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

  const walletMap: Record<
    string,
    { testnet: string; mainnet: string | null }
  > = {};

  for (const userData of demoUsers) {
    const user = await prisma.user.upsert({
      where: { authId: userData.authId },
      update: { lastLoginAt: new Date() },
      create: { ...userData, status: 'ACTIVE' },
    });

    const testnetPublicKey = demoPublicKey('GDEMO', userData.authId, 52);

    // Testnet wallet for each demo user
    const testnetWallet = await prisma.wallet.upsert({
      where: {
        network_publicKey: {
          network: WalletNetwork.TESTNET,
          publicKey: testnetPublicKey,
        },
      },
      update: {},
      create: {
        userId: user.id,
        publicKey: testnetPublicKey,
        encryptedSecret: `encrypted-demo-secret-${userData.authId}`,
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: WalletStatus.ACTIVE,
      },
    });

    // Mainnet wallet for each demo user. Opt-in only (#928): the row holds a
    // placeholder secret and must not exist unless a developer explicitly asks
    // for a mainnet-shaped fixture.
    let mainnetWalletId: string | null = null;
    if (preflight.includeMainnet) {
      const mainnetPublicKey = demoPublicKey('GMAIN', userData.authId, 51);
      const mainnetWallet = await prisma.wallet.upsert({
        where: {
          network_publicKey: {
            network: WalletNetwork.MAINNET,
            publicKey: mainnetPublicKey,
          },
        },
        update: {},
        create: {
          userId: user.id,
          publicKey: mainnetPublicKey,
          encryptedSecret: `encrypted-demo-secret-mainnet-${userData.authId}`,
          encryptionVersion: 1,
          secretVersion: 1,
          network: WalletNetwork.MAINNET,
          status: WalletStatus.ACTIVE,
        },
      });
      mainnetWalletId = mainnetWallet.id;
    }

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
      mainnet: mainnetWalletId,
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
    // A refused preflight is an operator decision, not a crash: print the
    // stable code and the remediation, never the connection string (#928).
    if (e instanceof SeedNotAllowedError) {
      console.error(`[${e.code}] ${e.message}`);
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
