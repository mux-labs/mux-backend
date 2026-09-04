import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '../entities/payment.entity';

export class UpdatePaymentDto {
  @ApiProperty({
    example: 'CONFIRMED',
    enum: PaymentStatus,
    description: 'New payment status',
    required: false,
  })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiProperty({
    example: 'Updated description',
    description: 'Updated payment description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;
}
