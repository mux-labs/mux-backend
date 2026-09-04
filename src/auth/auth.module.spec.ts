/**
 * @file auth.module.spec.ts
 *
 * Regression guard: AuthModule must list PrismaModule in its @Module({imports})
 * so that PrismaService is available for providers like RefreshTokenService.
 *
 * Without PrismaModule in imports, NestJS cannot inject PrismaService into
 * RefreshTokenService, and the module fails to compile at runtime.
 *
 * Design note: We inspect decorator metadata directly rather than compiling
 * the full module graph. The full graph requires real infra (DB, event-emitter)
 * and has its own setup in integration specs. The goal here is a fast,
 * hermetic regression guard that fails immediately if PrismaModule is removed
 * from the imports array.
 */

import 'reflect-metadata';
import { AuthModule } from './auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { IdempotentUserModule } from '../users/idempotent-user.module';
import { WalletsModule } from '../wallets/wallets.module';

describe('AuthModule - @Module metadata regression guards', () => {
  /**
   * NestJS stores the @Module({ imports }) array under the
   * 'imports' metadata key on the class. Reading it here is faster
   * and more hermetic than compiling the full module tree.
   */
  let imports: unknown[];

  beforeAll(() => {
    imports =
      (Reflect.getMetadata('imports', AuthModule) as unknown[]) ?? [];
  });

  // Issue #1 regression guard -------------------------------------------------

  it('should include PrismaModule in @Module imports (was omitted, causing DI failure)', () => {
    // This is the primary fix: the import was declared at the top of the file
    // but missing from the @Module({ imports }) array.
    expect(imports).toContain(PrismaModule);
  });

  it('should include IdempotentUserModule in @Module imports', () => {
    expect(imports).toContain(IdempotentUserModule);
  });

  it('should include WalletsModule in @Module imports', () => {
    expect(imports).toContain(WalletsModule);
  });

  // Provider registration guard -----------------------------------------------

  it('should list RefreshTokenService in providers', () => {
    const { RefreshTokenService } = require('./refresh-token.service');
    const providers =
      (Reflect.getMetadata('providers', AuthModule) as unknown[]) ?? [];
    expect(providers).toContain(RefreshTokenService);
  });

  it('should export RefreshTokenService', () => {
    const { RefreshTokenService } = require('./refresh-token.service');
    const exports =
      (Reflect.getMetadata('exports', AuthModule) as unknown[]) ?? [];
    expect(exports).toContain(RefreshTokenService);
  });
});
