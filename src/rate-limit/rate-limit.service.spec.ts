import { Test, TestingModule } from '@nestjs/testing';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RateLimitService],
    }).compile();

    service = module.get<RateLimitService>(RateLimitService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('consume', () => {
    it('counts one request against the developer quota and admits it', () => {
      const developerId = 'dev-1';
      const result = service.consume(developerId);

      expect(result).toBe(true);
    });

    it('denies the request once the quota is exceeded', () => {
      const developerId = 'dev-2';

      // Exhaust the quota for this developer.
      let admitted = true;
      let attempts = 0;
      while (admitted && attempts < 1000) {
        admitted = service.consume(developerId);
        attempts += 1;
      }

      // The next request must be denied.
      expect(service.consume(developerId)).toBe(false);
    });

    it('admits everything when the quota is disabled', () => {
      const developerId = 'dev-3';

      // Disable the quota flag (deny-by-default, instantly reversible).
      (service as unknown as { enabled: boolean }).enabled = false;

      for (let i = 0; i < 1000; i += 1) {
        expect(service.consume(developerId)).toBe(true);
      }
    });
  });
});
