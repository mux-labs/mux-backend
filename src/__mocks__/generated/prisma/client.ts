// Manual mock for the generated Prisma client
// Used in unit tests to avoid requiring a real database connection

export const PrismaClient = jest.fn().mockImplementation(() => ({
  $connect: jest.fn(),
  $disconnect: jest.fn(),
}));
