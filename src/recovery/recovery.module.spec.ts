import { Test, TestingModule } from '@nestjs/testing';
import { RecoveryModule } from './recovery.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RecoveryService } from './recovery.service';
import { AdminRecoveryService } from './admin-recovery.service';

describe('RecoveryModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [RecoveryModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  });

  it('should compile the module', () => {
    expect(module).toBeDefined();
  });

  it('should resolve PrismaService', () => {
    const prismaService = module.get(PrismaService);
    expect(prismaService).toBeDefined();
  });

  it('should resolve RecoveryService', () => {
    const recoveryService = module.get(RecoveryService);
    expect(recoveryService).toBeDefined();
  });

  it('should resolve AdminRecoveryService', () => {
    const adminRecoveryService = module.get(AdminRecoveryService);
    expect(adminRecoveryService).toBeDefined();
  });

  it('should include PrismaModule in its imports metadata', () => {
    const imports = Reflect.getMetadata('imports', RecoveryModule) ?? [];
    const hasPrisma = imports.some(
      (m: any) => m === PrismaModule || m?.name === 'PrismaModule',
    );
    expect(hasPrisma).toBe(true);
  });
});
