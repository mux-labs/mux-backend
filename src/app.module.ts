import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { PaymentsModule } from './payments/payments.module';
import { LimitsModule } from './limits/limits.module';
import { RecoveryModule } from './recovery/recovery.module';
import { KeyManagementModule } from './key-management/key-management.module';
import { BalanceIndexerModule } from './balance-indexer/balance-indexer.module';
import { WebhookModule } from './webhooks/webhook.module';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    UsersModule,
    WalletsModule,
    PaymentsModule,
    LimitsModule,
    RecoveryModule,
    KeyManagementModule,
    BalanceIndexerModule,
    WebhookModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
