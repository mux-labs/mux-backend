import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayNotEmpty,
  IsUrl,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWebhookEndpointDto {
  @ApiProperty({ example: 'project-uuid', description: 'Project ID' })
  @IsString({ message: 'projectId must be a string' })
  @IsNotEmpty({ message: 'projectId is required' })
  projectId: string;

  @ApiProperty({
    example: 'https://example.com/webhook',
    description: 'Endpoint URL to deliver events to',
  })
  @IsUrl({}, { message: 'url must be a valid URL' })
  @IsNotEmpty({ message: 'url is required' })
  url: string;

  @ApiProperty({
    example: ['wallet.created', 'transaction.confirmed'],
    description: 'List of event types to subscribe to',
  })
  @IsArray({ message: 'events must be an array' })
  @ArrayNotEmpty({ message: 'events must not be empty' })
  @IsString({ each: true, message: 'each event must be a string' })
  events: string[];

  @ApiProperty({
    example: 'My webhook endpoint',
    description: 'Optional description',
    required: false,
  })
  @IsString({ message: 'description must be a string' })
  @IsOptional()
  description?: string;
}
