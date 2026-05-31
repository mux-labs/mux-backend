import { Test, TestingModule } from '@nestjs/testing';
import { REQUIRE_API_KEY } from '../api-keys/api-key.guard';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

describe('WalletsController', () => {
  let controller: WalletsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [WalletsService],
    }).compile();

    controller = module.get<WalletsController>(WalletsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should mark protectedEndpoint with RequireApiKey metadata', () => {
    const metadata = Reflect.getMetadata(
      REQUIRE_API_KEY,
      controller.protectedEndpoint,
    );
    expect(metadata).toBe(true);
  });
});
