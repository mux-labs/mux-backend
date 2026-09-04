import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { ApiKeyContext } from '../api-keys/domain/api-key.model';
import {
  MaintenanceStatusDto,
  UpdateMaintenanceDto,
} from './dto/update-maintenance.dto';
import { MaintenanceAdminGuard } from './maintenance-admin.guard';
import { AllowDuringMaintenance } from './maintenance.decorator';
import { MaintenanceService } from './maintenance.service';

@ApiTags('maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get the current maintenance mode status (public inspection endpoint)' })
  @ApiResponse({ status: 200, type: MaintenanceStatusDto })
  getStatus(): Promise<MaintenanceStatusDto> {
    return this.maintenance.getStatus();
  }

  @Patch()
  @AllowDuringMaintenance()
  @UseGuards(MaintenanceAdminGuard)
  @ApiHeader({
    name: 'X-Maintenance-Secret',
    required: true,
    description: 'Maintenance administrator shared secret',
  })
  @ApiOperation({ summary: 'Enable or disable maintenance mode' })
  @ApiResponse({ status: 200, type: MaintenanceStatusDto })
  @ApiResponse({ status: 400, description: 'Invalid maintenance settings' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  updateStatus(
    @Body() update: UpdateMaintenanceDto,
    @Req() request: Request & { apiKeyContext?: ApiKeyContext },
  ): Promise<MaintenanceStatusDto> {
    return this.maintenance.updateStatus(
      update,
      request.apiKeyContext?.apiKey.id ?? 'internal',
    );
  }
}
