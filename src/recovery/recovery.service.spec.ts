import { Test, TestingModule } from '@nestjs/testing';
import { RecoveryService } from './recovery.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RecoveryService', () => {
  let service: RecoveryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoveryService,
        {
          provide: PrismaService,
          useValue: {
            recoveryRequest: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<RecoveryService>(RecoveryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
