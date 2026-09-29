import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/** Request body for `POST /v1/backup/restore`. */
export class RestoreBackupDto {
  @ApiProperty({
    description: 'Backup to restore from.',
    example: 'backup_1704067200000_abc',
  })
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  backupId!: string;

  @ApiPropertyOptional({
    description: 'Restore target network.',
    enum: ['testnet', 'mainnet'],
    default: 'testnet',
  })
  @IsOptional()
  @IsIn(['testnet', 'mainnet', 'TESTNET', 'MAINNET'])
  targetEnvironment?: string;
}
