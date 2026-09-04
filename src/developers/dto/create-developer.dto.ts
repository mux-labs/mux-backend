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

  /**
   * Owning user account. When set, deleting that user cleans up this
   * developer along with its projects, API keys, and webhook endpoints.
   * Optional — platform/onboarding developers may be unowned.
   */
  @IsOptional()
  @IsString()
  userId?: string;
}
