import { IsOptional, IsEnum, IsString, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { EndpointStatus } from '../domain/webhook-events';

export class WebhookFilterDto {
  @ApiProperty({
    example: EndpointStatus.ACTIVE,
    enum: EndpointStatus,
    description: 'Filter endpoints by status',
    required: false,
  })
  @IsEnum(EndpointStatus, { message: 'status must be a valid EndpointStatus' })
  @IsOptional()
  status?: EndpointStatus;

  @ApiProperty({
    example: 'wallet.created',
    description: 'Filter endpoints subscribed to this event type',
    required: false,
  })
  @IsString({ message: 'event must be a string' })
  @IsOptional()
  event?: string;

  @ApiProperty({
    example: 1,
    description: 'Page number (starting from 1)',
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer' })
  @Min(1, { message: 'page must be at least 1' })
  page?: number = 1;

  @ApiProperty({
    example: 20,
    description: 'Number of items per page (max 100)',
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(100, { message: 'limit must not exceed 100' })
  limit?: number = 20;
}
