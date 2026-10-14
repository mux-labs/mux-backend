import {
  IsString,
  IsOptional,
  IsArray,
  IsUrl,
  IsIn,
} from 'class-validator';

/**
 * DTO for updating a webhook endpoint.
 * All fields are optional; unknown fields are rejected (403).
 */
export class UpdateWebhookEndpointDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: string;
}
