import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { LimitsModule } from '../limits/limits.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [LimitsModule, WalletsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
