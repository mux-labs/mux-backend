import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { UserStatus } from '../entities/user.entity';

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  authProvider?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
