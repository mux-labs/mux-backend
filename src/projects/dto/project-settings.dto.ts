import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ProjectSettingsDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  environment?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitRpm?: number;

  @IsOptional()
  @IsString()
  status?: string;
}
