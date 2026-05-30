import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateDeveloperDto } from './create-developer.dto';

export class UpdateDeveloperDto extends PartialType(CreateDeveloperDto) {
  @IsOptional()
  @IsString()
  status?: string;
}
