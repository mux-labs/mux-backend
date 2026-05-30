import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
    appService = app.get<AppService>(AppService);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('checkHealth', () => {
    it('should return health status from service', () => {
      const result = appController.checkHealth();

      expect(result).toHaveProperty('status', 'ok');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('uptime');
    });

    it('should return valid health response structure', () => {
      const result = appController.checkHealth();

      expect(typeof result.status).toBe('string');
      expect(typeof result.timestamp).toBe('string');
      expect(typeof result.uptime).toBe('number');
    });

    it('should call appService.checkHealth', () => {
      const spy = jest.spyOn(appService, 'checkHealth');

      appController.checkHealth();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should return the same result as appService.checkHealth', () => {
      const serviceResult = appService.checkHealth();
      const controllerResult = appController.checkHealth();

      expect(controllerResult.status).toBe(serviceResult.status);
      expect(controllerResult.uptime).toBeGreaterThanOrEqual(0);
    });
  });
});
