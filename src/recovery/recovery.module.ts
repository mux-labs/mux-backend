import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryController } from './recovery.controller';

@Module({
  controllers: [RecoveryController],
  providers: [RecoveryService],
})
export class RecoveryModule {}
