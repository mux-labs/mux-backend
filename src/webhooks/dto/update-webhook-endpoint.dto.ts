import {
  IsString,
  IsArray,
  IsUrl,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EndpointStatus } from '../domain/webhook-events';

export class UpdateWebhookEndpointDto {
  @ApiProperty({
    example: 'https://example.com/webhook',
    description: 'New endpoint URL',
    required: false,
  })
  @IsUrl({}, { message: 'url must be a valid URL' })
  @IsOptional()
  url?: string;

  @ApiProperty({
    example: ['wallet.created'],
    description: 'Updated list of event types',
    required: false,
  })
  @IsArray({ message: 'events must be an array' })
  @IsString({ each: true, message: 'each event must be a string' })
  @IsOptional()
  events?: string[];

  @ApiProperty({
    example: 'Updated description',
    description: 'Optional description',
    required: false,
  })
  @IsString({ message: 'description must be a string' })
  @IsOptional()
  description?: string;

  @ApiProperty({
    example: EndpointStatus.ACTIVE,
    enum: EndpointStatus,
    description: 'Endpoint status',
    required: false,
  })
  @IsEnum(EndpointStatus, { message: 'status must be a valid EndpointStatus' })
  @IsOptional()
  status?: string;
}
