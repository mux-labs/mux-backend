import { Test, TestingModule } from '@nestjs/testing';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';

describe('LimitsController', () => {
  let controller: LimitsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [
        {
          provide: LimitsService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<LimitsController>(LimitsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
