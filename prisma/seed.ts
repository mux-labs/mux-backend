import { PrismaClient, WalletNetwork, WalletStatus } from '../src/generated/prisma';

// import { PrismaClient } from '@prisma/client';
// import { WalletNetwork, WalletStatus } from '../src/generated/prisma';

const prisma = new PrismaClient();

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

  for (const userData of demoUsers) {
    const user = await prisma.user.upsert({
      where: { authId: userData.authId },
      update: {},
      create: { ...userData, status: 'ACTIVE' },
    });

    // Testnet wallet for each demo user
    await prisma.wallet.upsert({
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

    console.log(`  Seeded user: ${userData.displayName} (${user.id})`);
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
