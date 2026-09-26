import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Allowed nickname charset: letters, digits, spaces and a small set of
 * punctuation. Deliberately excludes control characters, angle brackets and
 * other characters that could be abused for log/HTML injection.
 */
export const WALLET_NICKNAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

export const WALLET_NICKNAME_MIN_LENGTH = 1;
export const WALLET_NICKNAME_MAX_LENGTH = 100;

/**
 * Normalizes a nickname before validation/persistence:
 * - trims leading/trailing whitespace
 * - collapses internal whitespace runs to a single space
 * - applies Unicode NFC so visually identical labels compare equal
 *
 * `null`/`undefined` are preserved so the "clear nickname" path still works.
 */
export function normalizeWalletNickname(
  value: unknown,
): string | null | undefined {
  if (value === null || value === undefined) {
    return value as null | undefined;
  }
  if (typeof value !== 'string') {
    return value as unknown as string;
  }
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export class UpdateWalletNicknameDto {
  /**
   * Human-readable label for the wallet (e.g. "Savings", "Hot wallet").
   * Pass `null` to clear an existing nickname.
   */
  @ApiPropertyOptional({
    example: 'Savings wallet',
    description:
      'Human-readable label for the wallet. Pass null to clear the nickname.',
    minLength: WALLET_NICKNAME_MIN_LENGTH,
    maxLength: WALLET_NICKNAME_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeWalletNickname(value))
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MinLength(WALLET_NICKNAME_MIN_LENGTH)
  @MaxLength(WALLET_NICKNAME_MAX_LENGTH)
  @Matches(WALLET_NICKNAME_PATTERN, {
    message:
      'nickname may only contain letters, numbers, spaces and . _ \' -',
  })
  nickname?: string | null;
}
