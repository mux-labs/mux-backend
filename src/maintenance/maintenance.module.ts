import { Module } from '@nestjs/common';
import { MaintenanceAdminGuard } from './maintenance-admin.guard';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceSecretService } from './maintenance-secret.service';
import { MaintenanceService } from './maintenance.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Maintenance mode: the global write kill-switch and the admin surface that
 * controls it.
 *
 * `MaintenanceSecretService` is provided here (and exported) so
 * `MaintenanceAdminGuard` — the only consumer of the admin secret — resolves
 * the rotation window from one place.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MaintenanceController],
  providers: [
    MaintenanceService,
    MaintenanceGuard,
    MaintenanceAdminGuard,
    MaintenanceSecretService,
  ],
  exports: [MaintenanceService, MaintenanceGuard, MaintenanceSecretService],
})
export class MaintenanceModule {}
