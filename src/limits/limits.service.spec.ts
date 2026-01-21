import { Test, TestingModule } from '@nestjs/testing';
import { LimitsService } from './limits.service';

describe('LimitsService', () => {
  let service: LimitsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LimitsService],
    }).compile();

    service = module.get<LimitsService>(LimitsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
