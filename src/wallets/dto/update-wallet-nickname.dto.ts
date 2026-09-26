import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import {
  WALLET_NICKNAME_MAX_LENGTH,
  WalletNicknameErrorCode,
} from '../wallet-nickname-safety';

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
    maxLength: WALLET_NICKNAME_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  nickname?: string | null;
}
