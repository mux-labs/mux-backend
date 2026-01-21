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
  ],
export class AppModule {}
