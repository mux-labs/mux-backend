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
