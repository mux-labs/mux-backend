import { PartialType } from '@nestjs/mapped-types';
import { CreateRecoveryDto } from './create-recovery.dto';
import { RecoveryStatus } from '../domain/recovery.model';

export class UpdateRecoveryDto extends PartialType(CreateRecoveryDto) {
  status?: RecoveryStatus;
}
