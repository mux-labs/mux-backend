import { Module } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceSecretService } from './maintenance-secret.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MaintenanceGuard, MaintenanceSecretService],
  exports: [MaintenanceGuard, MaintenanceSecretService],
})
export class MaintenanceModule {}
