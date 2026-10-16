import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/public.decorator';

@Controller('maintenance')
class MaintenanceController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async maintenance() {
    try {
      const state = await this.prisma.maintenanceState.findFirst();
      return {
        enabled: state?.enabled ?? false,
        message: state?.message ?? null,
        retryAfterSeconds: state?.retryAfterSeconds ?? null,
      };
    } catch {
      throw new ServiceUnavailableException('Maintenance state is unavailable');
    }
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceGuard],
  exports: [MaintenanceGuard],
})
export class MaintenanceModule {}
