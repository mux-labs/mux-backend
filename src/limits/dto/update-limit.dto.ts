import { PartialType } from '@nestjs/mapped-types';
import { CreateLimitDto } from './create-limit.dto';

export class UpdateLimitDto extends PartialType(CreateLimitDto) {}
