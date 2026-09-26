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
   * Pass `null` (or omit) to clear an existing nickname.
   *
   * The value is sanitized for safe rendering in dashboards (HTML tags,
   * `javascript:` schemes, and inline `on*` handlers are stripped) and must be
   * unique (case-insensitive) among the non-archived wallets owned by the same
   * user, otherwise the request is rejected with 409.
   *
   * Length is deliberately NOT enforced here. `class-validator`'s `MaxLength`
   * counts UTF-16 code units, so it would reject a 100-character label made of
   * astral-plane characters (e.g. 100 emoji = 200 units) even though it is
   * within the documented limit. The store enforces the limit in Unicode code
   * points instead, so there is exactly one authority; see
   * `resolveNicknameToStore` in `./wallet-nickname-safety`.
   */
  @ApiPropertyOptional({
    example: 'Savings wallet',
    description:
      'Human-readable label for the wallet, sanitized before storage and unique per ' +
      `wallet owner. Rejected with ${WalletNicknameErrorCode.INVALID_INPUT} when longer ` +
      `than ${WALLET_NICKNAME_MAX_LENGTH} characters. Pass null to clear the nickname.`,
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
