import { IsEnum, IsNotEmpty, IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ChangeType, ChangeCategory } from '../domain/api-changelog.model';

export class CreateApiChangelogDto {
  @ApiProperty({
    example: '1.2.0',
    description: 'API version this changelog applies to',
  })
  @IsString()
  @IsNotEmpty()
  version: string;

  @ApiProperty({
    enum: ChangeType,
    example: ChangeType.ADDED,
    description: 'Type of change',
  })
  @IsEnum(ChangeType)
  @IsNotEmpty()
  changeType: ChangeType;

  @ApiProperty({
    enum: ChangeCategory,
    example: ChangeCategory.WALLETS,
    description: 'Category of the change',
  })
  @IsEnum(ChangeCategory)
  @IsNotEmpty()
  category: ChangeCategory;

  @ApiProperty({
    example: 'Add createdAt and updatedAt to wallet responses',
    description: 'Brief title of the change',
  })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    example: 'Wallet API now includes createdAt and updatedAt timestamps in all responses',
    description: 'Detailed description of the change',
  })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({
    example: ['GET /wallets', 'GET /wallets/{id}', 'POST /wallets'],
    description: 'List of affected API endpoints',
    required: false,
  })
  @IsArray()
  @IsOptional()
  affectedEndpoints?: string[];

  @ApiProperty({
    example: 'No migration needed - timestamp fields are auto-populated',
    description: 'Migration guide for API consumers',
    required: false,
  })
  @IsString()
  @IsOptional()
  migrationGuide?: string;
}
