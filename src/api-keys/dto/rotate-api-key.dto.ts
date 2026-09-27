import { IsOptional, IsString } from 'class-validator';

/**
 * DTO for rotating an API key.
 * Only whitelisted properties are accepted; unknown fields are rejected (403).
 */
export class RotateApiKeyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  developerId?: string;
}
