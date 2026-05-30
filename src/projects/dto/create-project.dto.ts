import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  name: string;

  @IsString()
  developerId: string;

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
}
