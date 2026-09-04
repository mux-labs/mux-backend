import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { AdminRecoveryService } from './admin-recovery.service';
import { RecoveryController } from './recovery.controller';
import { RecoveryAdminGuard } from './recovery-admin.guard';
import { ConfigModule } from '@nestjs/config';
import { WalletsModule } from '../wallets/wallets.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, WalletsModule, PrismaModule],
  controllers: [RecoveryController],
  providers: [RecoveryService, AdminRecoveryService, RecoveryAdminGuard],
  exports: [RecoveryService, AdminRecoveryService],
})
export class RecoveryModule {}
