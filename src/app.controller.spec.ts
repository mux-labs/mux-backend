import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: {
            getHello: jest.fn().mockReturnValue('Hello World!'),
            checkReadiness: jest.fn(),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
    appService = app.get<AppService>(AppService);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('checkReadiness', () => {
    it('should return ready status when database is connected', async () => {
      const mockReadyResponse = {
        status: 'ready',
        timestamp: new Date().toISOString(),
        database: {
          connected: true,
          responseTime: 10,
        },
      };

      jest
        .spyOn(appService, 'checkReadiness')
        .mockResolvedValue(mockReadyResponse);

      const result = await appController.checkReadiness();

      expect(result).toEqual(mockReadyResponse);
      expect(result.status).toBe('ready');
      expect(result.database.connected).toBe(true);
      expect(appService.checkReadiness).toHaveBeenCalledTimes(1);
    });

    it('should throw error when database is not connected', async () => {
      const mockNotReadyResponse = {
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        database: {
          connected: false,
          responseTime: 5,
          error: 'Connection refused',
        },
      };

      jest
        .spyOn(appService, 'checkReadiness')
        .mockResolvedValue(mockNotReadyResponse);

      await expect(appController.checkReadiness()).rejects.toThrow(
        'Service not ready: Database connection failed',
      );
      expect(appService.checkReadiness).toHaveBeenCalledTimes(1);
    });
  });
});
