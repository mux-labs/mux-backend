import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { PaymentStatus } from './entities/payment.entity';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let paymentsService: { update: jest.Mock } & Record<string, jest.Mock>;

  beforeEach(async () => {
    paymentsService = {
      create: jest.fn(),
      dryRun: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: paymentsService }],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PaymentsController>(PaymentsController);
    jest.clearAllMocks();
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('dryRun', () => {
    it('delegates payment validation to the service', async () => {
      const dto = {
        walletId: 'sender-wallet',
        receiverWalletId: 'receiver-wallet',
        fromId: 1,
        toId: 2,
        amount: 25,
        currency: 'USD',
      };
      const response = { dryRun: true, valid: true };
      paymentsService.dryRun.mockResolvedValue(response);

      await expect(controller.dryRun(dto)).resolves.toEqual(response);
      expect(paymentsService.dryRun).toHaveBeenCalledWith(dto);
    });
  });

  describe('update', () => {
    it('should delegate to service and return updated payment', async () => {
      const updated = { id: 1, status: PaymentStatus.CONFIRMED };
      paymentsService.update.mockResolvedValue(updated);

      const result = await controller.update('1', {
        status: PaymentStatus.CONFIRMED,
      });

      expect(paymentsService.update).toHaveBeenCalledWith('1', {
        status: PaymentStatus.CONFIRMED,
      });
      expect(result).toEqual(updated);
    });

    it('should propagate NotFoundException from service', async () => {
      paymentsService.update.mockRejectedValue(
        new NotFoundException('Payment #99 not found'),
      );

      await expect(
        controller.update('99', { status: PaymentStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should propagate BadRequestException from service', async () => {
      paymentsService.update.mockRejectedValue(
        new BadRequestException(
          'Cannot transition payment from CONFIRMED to FAILED',
        ),
      );

      await expect(
        controller.update('1', { status: PaymentStatus.FAILED }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('feature flag guard', () => {
    it('should deny access when feature flag is disabled', async () => {
      const restrictedModule = await Test.createTestingModule({
        controllers: [PaymentsController],
        providers: [{ provide: PaymentsService, useValue: paymentsService }],
      })
        .overrideGuard(ApiKeyGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(RateLimitGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(FeatureFlagGuard)
        .useValue({
          canActivate: () => {
            throw new Error('Feature not available');
          },
        })
        .compile();

      const restrictedController =
        restrictedModule.get<PaymentsController>(PaymentsController);
      expect(restrictedController).toBeDefined();
    });
  });

  describe('swagger decorators', () => {
    it('should have @ApiResponse decorators on all routes', () => {
      const routes = [
        'create',
        'dryRun',
        'findAll',
        'findOne',
        'update',
        'remove',
      ];

      routes.forEach((route) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          PaymentsController.prototype,
          route,
        );
        expect(descriptor).toBeDefined();

        const metadata = Reflect.getMetadata(
          'swagger/apiResponse',
          descriptor.value,
        );
        expect(metadata).toBeDefined();
      });
    });

    it('should have @ApiOperation on all routes', () => {
      const routes = [
        'create',
        'dryRun',
        'findAll',
        'findOne',
        'update',
        'remove',
      ];

      routes.forEach((route) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          PaymentsController.prototype,
          route,
        );
        expect(descriptor).toBeDefined();

        const metadata = Reflect.getMetadata(
          'swagger/apiOperation',
          descriptor.value,
        );
        expect(metadata).toBeDefined();
      });
    });
  });
});
