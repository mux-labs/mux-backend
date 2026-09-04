import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, HttpException } from '@nestjs/common';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthMetricsService } from './auth-metrics.service';

describe('AuthRateLimitGuard', () => {
  let guard: AuthRateLimitGuard;
  let authRateLimitService: jest.Mocked<AuthRateLimitService>;
  let authMetrics: jest.Mocked<AuthMetricsService>;

  const mockAuthRateLimitService = {
    checkRateLimit: jest.fn(),
    getConfig: jest.fn(),
  };

  const mockAuthMetrics = {
    recordAttempt: jest.fn(),
    recordRateLimitHit: jest.fn(),
    getSnapshot: jest.fn(),
    reset: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthRateLimitGuard,
        {
          provide: AuthRateLimitService,
          useValue: mockAuthRateLimitService,
        },
        {
          provide: AuthMetricsService,
          useValue: mockAuthMetrics,
        },
      ],
    }).compile();

    guard = module.get<AuthRateLimitGuard>(AuthRateLimitGuard);
    authRateLimitService = module.get(AuthRateLimitService);
    authMetrics = module.get(AuthMetricsService);

    jest.clearAllMocks();
  });

  describe('canActivate', () => {
    it('should allow request when within rate limit', async () => {
      // Arrange
      const mockRequest = {
        headers: {},
        connection: { remoteAddress: '192.168.1.1' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
      };
      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
          getResponse: jest.fn().mockReturnValue(mockResponse),
        }),
      } as any;

      mockAuthRateLimitService.checkRateLimit.mockResolvedValue({
        allowed: true,
        remaining: 9,
        resetTime: new Date(),
        limit: 10,
      });

      mockAuthRateLimitService.getConfig.mockReturnValue({
        maxRequests: 10,
        windowMs: 60000,
      });

      // Act
      const result = await guard.canActivate(mockExecutionContext);

      // Assert
      expect(result).toBe(true);
      expect(mockAuthRateLimitService.checkRateLimit).toHaveBeenCalledWith(
        '192.168.1.1',
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Limit',
        10,
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        9,
      );
    });

    it('should reject request when rate limit exceeded', async () => {
      // Arrange
      const mockRequest = {
        headers: {},
        connection: { remoteAddress: '192.168.1.1' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
      };
      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
          getResponse: jest.fn().mockReturnValue(mockResponse),
        }),
      } as any;

      mockAuthRateLimitService.checkRateLimit.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: new Date(Date.now() + 30000),
        limit: 10,
        retryAfterSeconds: 30,
      });

      mockAuthRateLimitService.getConfig.mockReturnValue({
        maxRequests: 10,
        windowMs: 60000,
      });

      // Act & Assert
      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        HttpException,
      );

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    });

    it('should extract IP from X-Forwarded-For header', async () => {
      // Arrange
      const mockRequest = {
        headers: { 'x-forwarded-for': '192.168.1.100, 10.0.0.1' },
        connection: { remoteAddress: '127.0.0.1' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
      };
      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
          getResponse: jest.fn().mockReturnValue(mockResponse),
        }),
      } as any;

      mockAuthRateLimitService.checkRateLimit.mockResolvedValue({
        allowed: true,
        remaining: 9,
        resetTime: new Date(),
        limit: 10,
      });

      mockAuthRateLimitService.getConfig.mockReturnValue({
        maxRequests: 10,
        windowMs: 60000,
      });

      // Act
      await guard.canActivate(mockExecutionContext);

      // Assert
      expect(mockAuthRateLimitService.checkRateLimit).toHaveBeenCalledWith(
        '192.168.1.100',
      );
    });

    it('should return 429 status code when rate limit exceeded', async () => {
      // Arrange
      const mockRequest = {
        headers: {},
        connection: { remoteAddress: '192.168.1.1' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
      };
      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
          getResponse: jest.fn().mockReturnValue(mockResponse),
        }),
      } as any;

      mockAuthRateLimitService.checkRateLimit.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: new Date(),
        limit: 10,
        retryAfterSeconds: 30,
      });

      mockAuthRateLimitService.getConfig.mockReturnValue({
        maxRequests: 10,
        windowMs: 60000,
      });

      // Act & Assert
      try {
        await guard.canActivate(mockExecutionContext);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('should call authMetrics.recordRateLimitHit() when rate limit is exceeded', async () => {
      const mockRequest = {
        headers: {},
        connection: { remoteAddress: '10.0.0.1' },
      };
      const mockResponse = { setHeader: jest.fn() };
      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
          getResponse: jest.fn().mockReturnValue(mockResponse),
        }),
      } as any;

      mockAuthRateLimitService.checkRateLimit.mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: new Date(Date.now() + 30000),
        limit: 10,
        retryAfterSeconds: 30,
      });
      mockAuthRateLimitService.getConfig.mockReturnValue({
        maxRequests: 10,
        windowMs: 60000,
      });

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        HttpException,
      );

      expect(mockAuthMetrics.recordRateLimitHit).toHaveBeenCalledTimes(1);
    });

    it('should NOT call authMetrics.recordRateLimitHit() when request is allowed', async () => {
      const mockRequest = {
        headers: {},
        connection: { remoteAddress: '10.0.0.2' },
      };
      const mockResponse = { setHeader: jest.fn() };
      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
          getResponse: jest.fn().mockReturnValue(mockResponse),
        }),
      } as any;

      mockAuthRateLimitService.checkRateLimit.mockResolvedValue({
        allowed: true,
        remaining: 5,
        resetTime: new Date(),
        limit: 10,
      });

      await guard.canActivate(mockExecutionContext);

      expect(mockAuthMetrics.recordRateLimitHit).not.toHaveBeenCalled();
    });
  });
});
