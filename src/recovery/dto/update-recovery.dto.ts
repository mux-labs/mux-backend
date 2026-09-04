import { IsOptional, IsString, IsEnum, IsObject } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecoveryStatus } from '../domain/recovery.model';

export class UpdateRecoveryDto {
  @ApiPropertyOptional({
    description: 'New recovery status',
    enum: RecoveryStatus,
    example: 'IN_REVIEW',
  })
  @IsOptional()
  @IsEnum(RecoveryStatus, {
    message: 'status must be a valid RecoveryStatus value',
  })
  status?: RecoveryStatus;

  @ApiPropertyOptional({
    description: 'Updated requester identifier',
    example: 'user_def456',
  })
  @IsOptional()
  @IsString()
  requester?: string;

  @ApiPropertyOptional({
    description: 'Arbitrary metadata for the recovery request',
    example: { reviewNote: 'Approved after ID verification' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
