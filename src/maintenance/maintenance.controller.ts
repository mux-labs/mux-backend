import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../auth/public.decorator';
import {
  MaintenanceStatusDto,
  UpdateMaintenanceDto,
} from './dto/update-maintenance.dto';
import { MaintenanceAdminGuard } from './maintenance-admin.guard';
import { AllowDuringMaintenance } from './maintenance.decorator';
import { MaintenanceService } from './maintenance.service';

/** Identity of the authenticated caller, as attached by the API-key guard. */
interface AuthenticatedRequest extends Request {
  apiKey?: { id?: string };
}

@ApiTags('maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  /**
   * Public status read. Carries no secret and no user data, so operators and
   * load balancers can poll it to decide whether to drain traffic.
   */
  @Get()
  @Public()
  @ApiOperation({ summary: 'Get the current maintenance mode status' })
  @ApiResponse({ status: 200, type: MaintenanceStatusDto })
  getStatus(): Promise<MaintenanceStatusDto> {
    return this.maintenance.getStatus();
  }

  /**
   * Enable or disable maintenance mode.
   *
   * Requires both normal API-key authentication (global `ApiKeyGuard`) and the
   * `X-Maintenance-Secret` header (`MaintenanceAdminGuard`). It is exempted
   * from `MaintenanceGuard` so the control that unfreezes the deployment stays
   * reachable while the deployment is frozen.
   */
  @Patch()
  @AllowDuringMaintenance()
  @UseGuards(MaintenanceAdminGuard)
  @ApiHeader({
    name: 'X-Maintenance-Secret',
    required: true,
    description:
      'Maintenance administrator shared secret (current, or previous inside its rotation window)',
  })
  @ApiOperation({ summary: 'Enable or disable maintenance mode' })
  @ApiResponse({ status: 200, type: MaintenanceStatusDto })
  @ApiResponse({ status: 400, description: 'Invalid maintenance settings' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credentials' })
  updateStatus(
    @Body() update: UpdateMaintenanceDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<MaintenanceStatusDto> {
    // The audit identity is the server-resolved API key, never a body field.
    return this.maintenance.updateStatus(
      update,
      request.apiKey?.id ?? 'internal',
    );
  }
}
