import { IsNumber, IsPositive } from 'class-validator';

export class CreateLimitDto {
  @IsNumber()
  @IsPositive()
  dailyLimit: number;

  @IsNumber()
  @IsPositive()
  perTransactionLimit: number;
}
