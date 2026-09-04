import { Module } from '@nestjs/common';
import { MaintenanceAdminGuard } from './maintenance-admin.guard';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceService } from './maintenance.service';

@Module({
  controllers: [MaintenanceController],
  providers: [MaintenanceService, MaintenanceGuard, MaintenanceAdminGuard],
  exports: [MaintenanceService, MaintenanceGuard],
})
export class MaintenanceModule {}
