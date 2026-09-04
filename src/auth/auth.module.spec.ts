import { Test, TestingModule } from '@nestjs/testing';
import { AuthModule } from './auth.module';
import { RefreshTokenService } from './refresh-token.service';
import { AuthOrchestrator } from './auth-orchestrator.service';

describe('AuthModule - DI Resolution', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
  });

  it('should compile and resolve RefreshTokenService', () => {
    const refreshTokenService = module.get(RefreshTokenService);
    expect(refreshTokenService).toBeDefined();
    expect(refreshTokenService).toBeInstanceOf(RefreshTokenService);
  });

  it('should compile and resolve AuthOrchestrator', () => {
    const authOrchestrator = module.get(AuthOrchestrator);
    expect(authOrchestrator).toBeDefined();
    expect(authOrchestrator).toBeInstanceOf(AuthOrchestrator);
  });

  it('should export RefreshTokenService', () => {
    const refreshTokenService = module.get(RefreshTokenService);
    expect(refreshTokenService).toBeDefined();
  });
});
