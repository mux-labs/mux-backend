import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AssetType } from '../../balance-indexer/domain/balance.model';

/** Positive decimal amount — must be > 0, e.g. "10", "0.0000001", "922337203685.4775807" */
const AMOUNT_REGEX = /^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/;

/** Stellar public key: G followed by 55 uppercase alphanumeric chars */
const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z0-9]{55}$/;

export class TransactionAssetDto {
  @IsEnum(AssetType)
  type: AssetType;

  /** Required for non-native assets */
  @ValidateIf((o) => o.type !== AssetType.NATIVE)
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  code?: string;

  /** Required for non-native assets */
  @ValidateIf((o) => o.type !== AssetType.NATIVE)
  @IsString()
  @Matches(STELLAR_PUBLIC_KEY_REGEX, {
    message: 'issuer must be a valid Stellar public key',
  })
  issuer?: string;
}

export class CreateTransactionDto {
  /** Positive decimal string, up to 7 decimal places (Stellar precision) */
  @IsString()
  @Matches(AMOUNT_REGEX, {
    message: 'amount must be a positive decimal with up to 7 decimal places',
  })
  amount: string;

  @ValidateNested()
  @Type(() => TransactionAssetDto)
  asset: TransactionAssetDto;

  @IsUUID()
  senderWalletId: string;

  @IsOptional()
  @IsUUID()
  receiverWalletId?: string;

  /** Optional memo — max 28 bytes (Stellar text memo limit) */
  @IsOptional()
  @IsString()
  @MaxLength(28)
  memo?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
