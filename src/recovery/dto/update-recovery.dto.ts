import { PartialType } from '@nestjs/mapped-types';
import { CreateRecoveryDto } from './create-recovery.dto';

export class UpdateRecoveryDto extends PartialType(CreateRecoveryDto) {}
