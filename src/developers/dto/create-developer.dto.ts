import { IsEmail, IsOptional, IsString } from 'class-validator';

export class CreateDeveloperDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  company?: string;
}
