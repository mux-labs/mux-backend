import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateWalletNicknameDto {
  /**
   * Human-readable label for the wallet (e.g. "Savings", "Hot wallet").
   * Pass `null` (or omit) to clear an existing nickname.
   *
   * The value is sanitized for safe rendering in dashboards (HTML tags,
   * `javascript:` schemes, and inline `on*` handlers are stripped). It must be
   * unique (case-insensitive) among the non-archived wallets owned by the same
   * user, otherwise the request is rejected with 409.
   */
  @ApiPropertyOptional({
    example: 'Savings wallet',
    description:
      'Human-readable label for the wallet, sanitized before storage and unique per wallet owner. Pass null to clear the nickname.',
    maxLength: 100,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string | null;
}
