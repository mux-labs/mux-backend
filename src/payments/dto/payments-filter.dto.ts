import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '../entities/payment.entity';

export class PaymentsFilterDto {
  @ApiProperty({
    example: 'PENDING',
    enum: PaymentStatus,
    description: 'Filter by payment status',
    required: false,
  })
  @IsEnum(PaymentStatus, { message: 'status must be one of: PENDING, CONFIRMED, FAILED' })
  @IsOptional()
  status?: PaymentStatus;
}
