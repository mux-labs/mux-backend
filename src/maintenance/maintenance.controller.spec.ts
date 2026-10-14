import { UnauthorizedException } from '@nestjs/common';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
import { UpdateMaintenanceDto } from './dto/update-maintenance.dto';

describe('MaintenanceController (#966, #967)', () => {
  let controller: MaintenanceController;
  let maintenanceService: jest.Mocked<MaintenanceService>;

  beforeEach(() => {
    maintenanceService = {
      getStatus: jest.fn(),
      updateStatus: jest.fn(),
    } as unknown as jest.Mocked<MaintenanceService>;

    controller = new MaintenanceController(maintenanceService);
  });

  describe('GET /maintenance (#966 - Public maintenance GET no secret leak)', () => {
    it('returns public maintenance status without leaking caller identity or secrets', async () => {
      maintenanceService.getStatus.mockResolvedValue({
        enabled: true,
        message: 'Scheduled maintenance: network upgrade',
        retryAfterSeconds: 300,
        enabledAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const res = await controller.getStatus();

      expect(res).toEqual({
        enabled: true,
        message: 'Scheduled maintenance: network upgrade',
        retryAfterSeconds: 300,
        enabledAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });
      expect(res).not.toHaveProperty('updatedBy');
      expect(JSON.stringify(res)).not.toMatch(/updatedBy/);
    });
  });

  describe('PATCH /maintenance (#967 - PATCH maintenance dual auth)', () => {
    const dto: UpdateMaintenanceDto = {
      enabled: true,
      message: 'Urgent maintenance',
      retryAfterSeconds: 120,
    };

    it('requires API key caller ID and rejects if missing', async () => {
      const emptyReq: any = { apiKey: undefined };

      await expect(controller.updateStatus(dto, emptyReq)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(maintenanceService.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects when apiKey object is present but id is missing', async () => {
      const noIdReq: any = { apiKey: {} };

      await expect(controller.updateStatus(dto, noIdReq)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(maintenanceService.updateStatus).not.toHaveBeenCalled();
    });

    it('accepts valid API key identity (apiKey.id) and passes callerId to service', async () => {
      const req: any = { apiKey: { id: 'api-key-test-123' } };
      maintenanceService.updateStatus.mockResolvedValue({
        enabled: true,
        message: 'Urgent maintenance',
        retryAfterSeconds: 120,
        enabledAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const res = await controller.updateStatus(dto, req);

      expect(maintenanceService.updateStatus).toHaveBeenCalledWith(
        dto,
        'api-key-test-123',
      );
      expect(res.enabled).toBe(true);
      expect(res).not.toHaveProperty('updatedBy');
    });

    it('accepts nested apiKey.apiKey.id structure', async () => {
      const req: any = { apiKey: { apiKey: { id: 'nested-key-id' } } };
      maintenanceService.updateStatus.mockResolvedValue({
        enabled: true,
        message: 'Urgent maintenance',
        retryAfterSeconds: 120,
        enabledAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      });

      const res = await controller.updateStatus(dto, req);

      expect(maintenanceService.updateStatus).toHaveBeenCalledWith(
        dto,
        'nested-key-id',
      );
      expect(res.enabled).toBe(true);
    });
  });
});
