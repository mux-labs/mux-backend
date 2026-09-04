import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreatePaymentDto } from './create-payment.dto';

export class BatchPaymentDto {
  @ApiProperty({
    type: [CreatePaymentDto],
    description:
      'Array of payments to process. Must contain at least one item.',
    minItems: 1,
  })
  @IsArray({ message: 'payments must be an array' })
  @ArrayMinSize(1, { message: 'payments must not be empty' })
  @ValidateNested({ each: true })
  @Type(() => CreatePaymentDto)
  payments: CreatePaymentDto[];
}
