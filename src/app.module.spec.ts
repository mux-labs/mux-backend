import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { MaintenanceService } from './maintenance/maintenance.service';
import { MaintenanceGuard } from './maintenance/maintenance.guard';

describe('AppModule - DI Resolution', () => {
  let app: INestApplication;

  it('should compile and resolve MaintenanceGuard and MaintenanceService', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const maintenanceService = moduleFixture.get(MaintenanceService);
    const maintenanceGuard = moduleFixture.get(MaintenanceGuard);

    expect(maintenanceService).toBeDefined();
    expect(maintenanceGuard).toBeDefined();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });
});
