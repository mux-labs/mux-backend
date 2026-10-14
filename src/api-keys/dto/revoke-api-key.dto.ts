import { IsOptional, IsString } from 'class-validator';

/**
 * DTO for revoking an API key.
 * Only whitelisted properties are accepted; unknown fields are rejected (403).
 */
export class RevokeApiKeyDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  developerId?: string;
}
