import { ApiProperty } from '@nestjs/swagger';
import { ChangeType, ChangeCategory } from '../domain/api-changelog.model';

export class ApiChangelogResponseDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Changelog entry unique identifier',
  })
  id: string;

  @ApiProperty({
    example: '1.2.0',
    description: 'API version this changelog applies to',
  })
  version: string;

  @ApiProperty({
    enum: ChangeType,
    example: ChangeType.ADDED,
  })
  changeType: ChangeType;

  @ApiProperty({
    enum: ChangeCategory,
    example: ChangeCategory.WALLETS,
  })
  category: ChangeCategory;

  @ApiProperty({
    example: 'Add createdAt and updatedAt to wallet responses',
  })
  title: string;

  @ApiProperty({
    example: 'Wallet API now includes createdAt and updatedAt timestamps in all responses',
  })
  description: string;

  @ApiProperty({
    example: ['GET /wallets', 'GET /wallets/{id}', 'POST /wallets'],
    nullable: true,
  })
  affectedEndpoints?: string[];

  @ApiProperty({
    example: 'No migration needed - timestamp fields are auto-populated',
    nullable: true,
  })
  migrationGuide?: string;

  @ApiProperty({
    example: '2026-07-26T12:00:00Z',
    description: 'ISO 8601 timestamp when entry was published',
  })
  publishedAt: Date;

  @ApiProperty({
    example: '2026-07-26T10:00:00Z',
    description: 'ISO 8601 timestamp when entry was created',
  })
  createdAt: Date;

  @ApiProperty({
    example: '2026-07-26T12:00:00Z',
    description: 'ISO 8601 timestamp when entry was last updated',
  })
  updatedAt: Date;
}
