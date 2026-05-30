import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';

describe('AppService', () => {
  let service: AppService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    }).compile();

    service = module.get<AppService>(AppService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getHello', () => {
    it('should return "Hello World!"', () => {
      expect(service.getHello()).toBe('Hello World!');
    });
  });

  describe('checkHealth', () => {
    it('should return health status with ok status', () => {
      const result = service.checkHealth();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(result.uptime).toBeDefined();
    });

    it('should return valid ISO timestamp', () => {
      const result = service.checkHealth();

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date');
      
      // Verify it's a recent timestamp (within last second)
      const timestamp = new Date(result.timestamp);
      const now = new Date();
      const diff = now.getTime() - timestamp.getTime();
      expect(diff).toBeLessThan(1000);
    });

    it('should return uptime as a number', () => {
      const result = service.checkHealth();

      expect(typeof result.uptime).toBe('number');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return increasing uptime on subsequent calls', async () => {
      const result1 = service.checkHealth();
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const result2 = service.checkHealth();

      expect(result2.uptime).toBeGreaterThanOrEqual(result1.uptime);
    });

    it('should include version if npm_package_version is set', () => {
      const originalVersion = process.env.npm_package_version;
      process.env.npm_package_version = '1.0.0';

      const result = service.checkHealth();

      expect(result.version).toBe('1.0.0');

      // Restore original value
      if (originalVersion) {
        process.env.npm_package_version = originalVersion;
      } else {
        delete process.env.npm_package_version;
      }
    });

    it('should not include version if npm_package_version is not set', () => {
      const originalVersion = process.env.npm_package_version;
      delete process.env.npm_package_version;

      const result = service.checkHealth();

      expect(result.version).toBeUndefined();

      // Restore original value
      if (originalVersion) {
        process.env.npm_package_version = originalVersion;
      }
    });

    it('should return consistent structure on multiple calls', () => {
      const result1 = service.checkHealth();
      const result2 = service.checkHealth();

      expect(result1).toHaveProperty('status');
      expect(result1).toHaveProperty('timestamp');
      expect(result1).toHaveProperty('uptime');

      expect(result2).toHaveProperty('status');
      expect(result2).toHaveProperty('timestamp');
      expect(result2).toHaveProperty('uptime');
    });

    it('should always return ok status', () => {
      // Call multiple times
      for (let i = 0; i < 5; i++) {
        const result = service.checkHealth();
        expect(result.status).toBe('ok');
      }
    });

    it('should calculate uptime from service start time', () => {
      const result = service.checkHealth();

      // Uptime should be a small number since service was just created
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.uptime).toBeLessThan(10); // Less than 10 seconds
    });
  });
});
