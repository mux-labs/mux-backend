import { IsString, IsNotEmpty, IsOptional, IsDateString } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  projectId: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
