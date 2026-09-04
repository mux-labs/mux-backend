import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateMaintenanceDto {
  @ApiProperty({ description: 'Whether mutating API routes are unavailable' })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({
    description: 'Safe, user-facing maintenance explanation',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @ApiPropertyOptional({
    description: 'Suggested delay before clients retry, in seconds',
    minimum: 1,
    maximum: 86400,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  retryAfterSeconds?: number;
}

export class MaintenanceStatusDto {
  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ nullable: true })
  message: string | null;

  @ApiProperty({ nullable: true })
  retryAfterSeconds: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  enabledAt: Date | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  updatedAt: Date | null;
}
