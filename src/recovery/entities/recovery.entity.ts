import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecoveryStatus } from '../domain/recovery.model';

export class RecoveryRequest {
  @ApiProperty({ description: 'Recovery request UUID', example: '660e8400-e29b-41d4-a716-446655440001' })
  id: string;

  @ApiProperty({ description: 'Wallet ID being recovered', example: '550e8400-e29b-41d4-a716-446655440000' })
  walletId: string;

  @ApiProperty({ description: 'Requester identifier', example: 'user_abc123' })
  requester: string;

  @ApiProperty({ description: 'Current recovery status', enum: RecoveryStatus, example: RecoveryStatus.PENDING })
  status: RecoveryStatus;

  @ApiPropertyOptional({ description: 'Arbitrary metadata', example: { reason: 'lost_access' } })
  metadata?: any | null;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-06-29T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp', example: '2026-06-29T12:00:00.000Z' })
  updatedAt: Date;
}
