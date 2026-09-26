import { Module } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MaintenanceGuard],
  exports: [MaintenanceGuard],
})
export class MaintenanceModule {}