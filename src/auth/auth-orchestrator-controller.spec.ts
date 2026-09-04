import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import { AuthModule } from './auth.module';
import { RefreshTokenService } from './refresh-token.service';
import { AuthOrchestrator } from './auth-orchestrator.service';

describe('AuthOrchestratorController - DI Resolution', () => {
  let app: INestApplication;
  let controller: AuthOrchestratorController;
  let refreshTokenService: RefreshTokenService;
  let authOrchestrator: AuthOrchestrator;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    controller = moduleFixture.get(AuthOrchestratorController);
    refreshTokenService = moduleFixture.get(RefreshTokenService);
    authOrchestrator = moduleFixture.get(AuthOrchestrator);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('should compile and instantiate the controller with RefreshTokenService dependency', () => {
    expect(controller).toBeDefined();
    expect(controller).toBeInstanceOf(AuthOrchestratorController);
  });

  it('should resolve RefreshTokenService as a dependency', () => {
    expect(refreshTokenService).toBeDefined();
    expect(refreshTokenService).toBeInstanceOf(RefreshTokenService);
  });

  it('should resolve AuthOrchestrator as a dependency', () => {
    expect(authOrchestrator).toBeDefined();
    expect(authOrchestrator).toBeInstanceOf(AuthOrchestrator);
  });

  it('should have RefreshTokenService methods available for token rotation', () => {
    expect(refreshTokenService.rotateRefreshToken).toBeDefined();
    expect(typeof refreshTokenService.rotateRefreshToken).toBe('function');

    expect(refreshTokenService.validateAndRotateToken).toBeDefined();
    expect(typeof refreshTokenService.validateAndRotateToken).toBe('function');

    expect(refreshTokenService.revokeRefreshToken).toBeDefined();
    expect(typeof refreshTokenService.revokeRefreshToken).toBe('function');
  });
});
