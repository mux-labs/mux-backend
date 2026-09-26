import { Module } from '@nestjs/common';
import { TransactionEnvValidatorService } from './transaction-env-validator.service';

/**
 * Boot-time transaction environment validation. Import this module from the
 * app root so `TransactionEnvValidatorService.onModuleInit()` runs during
 * startup and fails closed on mainnet payment misconfiguration.
 */
@Module({
  providers: [TransactionEnvValidatorService],
  exports: [TransactionEnvValidatorService],
})
export class TransactionEnvValidatorModule {}