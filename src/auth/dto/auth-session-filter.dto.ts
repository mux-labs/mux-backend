import { IsEnum, IsOptional, IsString, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../users/entities/user.entity';

export class AuthSessionFilterDto {
  @ApiProperty({
    enum: UserStatus,
    required: false,
    description: 'Filter sessions by user account status',
    example: 'ACTIVE',
  })
  @IsOptional()
  @IsEnum(UserStatus, {
    message: `status must be one of: ${Object.values(UserStatus).join(', ')}`,
  })
  status?: UserStatus;

  @ApiProperty({
    required: false,
    description: 'Filter sessions by authentication provider',
    example: 'GOOGLE',
  })
  @IsOptional()
  @IsString()
  authProvider?: string;

  @ApiProperty({
    required: false,
    description: 'Filter sessions with lastLoginAt on or after this ISO date',
    example: '2024-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiProperty({
    required: false,
    description: 'Filter sessions with lastLoginAt on or before this ISO date',
    example: '2024-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
