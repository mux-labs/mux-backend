import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsUrl,
  ArrayNotEmpty,
} from 'class-validator';

/**
 * DTO for creating a webhook endpoint.
 * Only whitelisted properties are accepted; unknown fields are rejected (403).
 */
export class CreateWebhookEndpointDto {
  @IsString()
  @IsNotEmpty()
  projectId: string;

  @IsUrl({ require_tld: false })
  url: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events: string[];

  @IsOptional()
  @IsString()
  description?: string;
}
