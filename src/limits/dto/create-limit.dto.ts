import {
  IsString,
  IsUUID,
  IsNumber,
  IsPositive,
  IsEnum,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';

export enum LimitPeriod {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

export class CreateLimitDto {
  @IsUUID()
  userId: string;

  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  perTransactionLimit: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  periodLimit: number;

  @IsEnum(LimitPeriod)
  @IsOptional()
  period?: LimitPeriod;

  @IsString()
  @MaxLength(12)
  @IsOptional()
  assetCode?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
