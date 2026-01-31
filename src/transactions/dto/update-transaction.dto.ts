import { PartialType } from '@nestjs/mapped-types';
import { CreateTransactionDto } from './create-transaction.dto';
import { TransactionStatus } from '../domain/transaction.model';

export class UpdateTransactionStatusDto {
  status: TransactionStatus;
  statusReason?: string;
  stellarHash?: string;
  stellarLedger?: number;
  stellarFee?: string;
}

export class UpdateTransactionDto extends PartialType(CreateTransactionDto) {}
