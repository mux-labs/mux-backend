import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  BadRequestException,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiParam,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { RecoveryService } from './recovery.service';
import { AdminRecoveryService } from './admin-recovery.service';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';
import { RecoveryStatus } from './domain/recovery.model';
import { RecoveryAdminGuard } from './recovery-admin.guard';

interface RecoveryAdminRequest {
  approvalNotes?: string;
  rejectionReason?: string;
}

function parsePaginationParam(
  value: string | undefined,
  name: string,
  max = 100,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestException(
      `${name} must be a non-negative integer`,
    );
  }
  if (name === 'limit' && n > max) {
    throw new BadRequestException(`limit must not exceed ${max}`);
  }
  return n;
}

@ApiTags('recovery')
@Controller('recovery')
export class RecoveryController {
  constructor(
    private readonly recoveryService: RecoveryService,
    private readonly adminRecoveryService: AdminRecoveryService,
  ) {}

  @ApiOperation({
    summary: 'Create a recovery request',
    description:
      'Create a new recovery request for a wallet. An active recovery request already exists for the same wallet will be rejected.',
  })
  @ApiBody({
    type: CreateRecoveryDto,
    examples: {
      default: {
        summary: 'Standard recovery request',
        value: {
          walletId: '550e8400-e29b-41d4-a716-446655440000',
          requester: 'user_abc123',
          metadata: {
            reason: 'lost_access',
            contactEmail: 'user@example.com',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Recovery request created successfully',
    schema: {
      example: {
        id: '660e8400-e29b-41d4-a716-446655440001',
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
        status: 'PENDING',
        metadata: {
          reason: 'lost_access',
          contactEmail: 'user@example.com',
        },
        createdAt: '2026-06-29T12:00:00.000Z',
        updatedAt: '2026-06-29T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid input, wallet not found, or active recovery exists',
    schema: {
      example: {
        statusCode: 400,
        message: ['walletId must be a UUID', 'requester must be a string'],
        error: 'Bad Request',
      },
    },
  })
  @Post()
  create(@Body() createRecoveryDto: CreateRecoveryDto) {
    return this.recoveryService.create(createRecoveryDto);
  }

  @ApiOperation({
    summary: 'List recovery requests with optional filters and pagination',
    description:
      'Retrieve a paginated list of recovery requests. Supports filtering by wallet ID, requester, and status.',
  })
  @ApiQuery({
    name: 'walletId',
    required: false,
    description: 'Filter by wallet ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiQuery({
    name: 'requester',
    required: false,
    description: 'Filter by requester (partial match, case-insensitive)',
    example: 'user_abc',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: RecoveryStatus,
    description: 'Filter by recovery status',
    example: 'PENDING',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max records to return (1-100, default 20)',
    example: 20,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of records to skip (default 0)',
    example: 0,
  })
  @ApiQuery({
    name: 'createdAtFrom',
    required: false,
    description: 'Filter records created on or after this ISO date',
    example: '2026-01-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'createdAtTo',
    required: false,
    description: 'Filter records created on or before this ISO date',
    example: '2026-12-31T23:59:59.999Z',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of recovery requests',
    schema: {
      example: {
        data: [
          {
            id: '660e8400-e29b-41d4-a716-446655440001',
            walletId: '550e8400-e29b-41d4-a716-446655440000',
            requester: 'user_abc123',
            status: 'PENDING',
            metadata: { reason: 'lost_access' },
            createdAt: '2026-06-29T12:00:00.000Z',
            updatedAt: '2026-06-29T12:00:00.000Z',
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
        hasMore: false,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid pagination parameters',
    schema: {
      example: {
        statusCode: 400,
        message: 'limit must not exceed 100',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid status enum value',
    schema: {
      example: {
        statusCode: 400,
        message: 'status must be a valid RecoveryStatus value: PENDING, IN_REVIEW, APPROVED, REJECTED, COMPLETED, CANCELLED',
        error: 'Bad Request',
      },
    },
  })
  @Get()
  findAll(
    @Query('walletId') walletId?: string,
    @Query('requester') requester?: string,
    @Query('status') status?: RecoveryStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('createdAtFrom') createdAtFrom?: string,
    @Query('createdAtTo') createdAtTo?: string,
  ) {
    if (status !== undefined && !Object.values(RecoveryStatus).includes(status as RecoveryStatus)) {
      throw new BadRequestException(
        `status must be a valid RecoveryStatus value: ${Object.values(RecoveryStatus).join(', ')}`,
      );
    }

    const createdAtFilter: { gte?: Date; lte?: Date } = {};
    if (createdAtFrom !== undefined) {
      const d = new Date(createdAtFrom);
      if (isNaN(d.getTime())) {
        throw new BadRequestException('createdAtFrom must be a valid ISO date string');
      }
      createdAtFilter.gte = d;
    }
    if (createdAtTo !== undefined) {
      const d = new Date(createdAtTo);
      if (isNaN(d.getTime())) {
        throw new BadRequestException('createdAtTo must be a valid ISO date string');
      }
      createdAtFilter.lte = d;
    }

    return this.recoveryService.findAll({
      walletId,
      requester,
      status: status as RecoveryStatus,
      limit: parsePaginationParam(limit, 'limit'),
      offset: parsePaginationParam(offset, 'offset'),
      createdAt: Object.keys(createdAtFilter).length > 0 ? createdAtFilter : undefined,
    });
  }

  @ApiOperation({
    summary: 'Get a recovery request by ID',
    description: 'Retrieve a single recovery request by its UUID.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recovery request UUID',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery request found',
    schema: {
      example: {
        id: '660e8400-e29b-41d4-a716-446655440001',
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
        status: 'PENDING',
        metadata: { reason: 'lost_access' },
        createdAt: '2026-06-29T12:00:00.000Z',
        updatedAt: '2026-06-29T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid UUID',
    schema: {
      example: {
        statusCode: 400,
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Recovery request not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Recovery request not found',
        error: 'Not Found',
      },
    },
  })
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.recoveryService.findOne(id);
  }

  @ApiOperation({
    summary: 'Update a recovery request status',
    description:
      'Update a recovery request status. Valid transitions: PENDING→IN_REVIEW, PENDING→CANCELLED, IN_REVIEW→APPROVED, IN_REVIEW→REJECTED, IN_REVIEW→CANCELLED, APPROVED→COMPLETED, APPROVED→CANCELLED.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recovery request UUID',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  @ApiBody({
    type: UpdateRecoveryDto,
    examples: {
      review: {
        summary: 'Move to IN_REVIEW',
        value: { status: 'IN_REVIEW' },
      },
      approve: {
        summary: 'Approve recovery',
        value: { status: 'APPROVED' },
      },
      reject: {
        summary: 'Reject recovery',
        value: { status: 'REJECTED' },
      },
      complete: {
        summary: 'Complete recovery',
        value: { status: 'COMPLETED' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery request updated',
    schema: {
      example: {
        id: '660e8400-e29b-41d4-a716-446655440001',
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
        status: 'IN_REVIEW',
        metadata: { reason: 'lost_access' },
        createdAt: '2026-06-29T12:00:00.000Z',
        updatedAt: '2026-06-29T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid UUID or invalid status transition',
    schema: {
      example: {
        statusCode: 400,
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Recovery request not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Recovery request not found',
        error: 'Not Found',
      },
    },
  })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateRecoveryDto: UpdateRecoveryDto,
  ) {
    return this.recoveryService.update(id, updateRecoveryDto);
  }

  @ApiOperation({
    summary: 'Initiate a recovery request',
    description:
      'Initiate review of a PENDING recovery request, moving it to IN_REVIEW. Only requests currently in PENDING status can be initiated.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recovery request UUID',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  @ApiResponse({
    status: 201,
    description: 'Recovery request initiated and moved to IN_REVIEW',
    schema: {
      example: {
        id: '660e8400-e29b-41d4-a716-446655440001',
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
        status: 'IN_REVIEW',
        metadata: { reason: 'lost_access' },
        createdAt: '2026-06-29T12:00:00.000Z',
        updatedAt: '2026-06-29T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad request - invalid UUID or recovery request is not in PENDING status',
    schema: {
      example: {
        statusCode: 400,
        message:
          'Recovery request cannot be initiated from status IN_REVIEW; it must be PENDING',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Recovery request not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Recovery request not found',
        error: 'Not Found',
      },
    },
  })
  @Post(':id/initiate')
  initiate(@Param('id', ParseUUIDPipe) id: string) {
    return this.recoveryService.initiate(id);
  }

  @ApiOperation({
    summary: 'Cancel a recovery request',
    description:
      'Cancels a recovery request by moving it to CANCELLED status. ' +
      'Only requests in PENDING, IN_REVIEW, or APPROVED state can be cancelled. ' +
      'Requests that are already COMPLETED, REJECTED, or CANCELLED cannot be cancelled.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recovery request UUID',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery request cancelled',
    schema: {
      example: {
        id: '660e8400-e29b-41d4-a716-446655440001',
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
        status: 'CANCELLED',
        metadata: { reason: 'lost_access' },
        createdAt: '2026-06-29T12:00:00.000Z',
        updatedAt: '2026-06-29T12:30:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid UUID or cancellation not allowed from current status',
    schema: {
      example: {
        statusCode: 400,
        message:
          'Recovery request cannot be cancelled from status COMPLETED. ' +
          'Only PENDING, IN_REVIEW, or APPROVED requests can be cancelled.',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Recovery request not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Recovery request not found',
        error: 'Not Found',
      },
    },
  })
  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.recoveryService.cancel(id);
  }

  @ApiOperation({
    summary: 'Delete a recovery request',
    description: 'Permanently delete a recovery request by ID.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recovery request UUID',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery request deleted successfully',
    schema: {
      example: { message: 'Recovery request deleted successfully' },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid UUID',
    schema: {
      example: {
        statusCode: 400,
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Recovery request not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Recovery request not found',
        error: 'Not Found',
      },
    },
  })
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.recoveryService.remove(id);
    return { message: 'Recovery request deleted successfully' };
  }

  @ApiOperation({
    summary: 'Get recovery status for a wallet',
    description: 'Retrieve the recovery status for a specific wallet, including information about any active recovery requests.',
  })
  @ApiParam({
    name: 'walletId',
    description: 'Wallet UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({
    status: 200,
    description: 'Wallet recovery status retrieved',
    schema: {
      example: {
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        hasActiveRecovery: true,
        currentStatus: 'IN_REVIEW',
        recoveryRequestId: '660e8400-e29b-41d4-a716-446655440001',
        lastUpdatedAt: '2026-06-29T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid UUID',
    schema: {
      example: {
        statusCode: 400,
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Wallet not found',
        error: 'Not Found',
      },
    },
  })
  @Get('wallet/:walletId/status')
  async getWalletRecoveryStatus(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.recoveryService.getWalletRecoveryStatus(walletId);
  }

  /**
   * Admin endpoint: Approve a recovery request
   */
  @Post('admin/approve/:id')
  @UseGuards(RecoveryAdminGuard)
  @HttpCode(HttpStatus.OK)
  async approveRecovery(
    @Param('id', ParseUUIDPipe) recoveryId: string,
    @Body() request: RecoveryAdminRequest,
    @Req() httpRequest: Request,
  ) {
    return this.adminRecoveryService.approveRecovery({
      recoveryId,
      adminId: (httpRequest as any).recoveryAdminId,
      approvalNotes: request.approvalNotes,
    });
  }

  /**
   * Admin endpoint: Reject a recovery request
   */
  @Post('admin/reject/:id')
  @UseGuards(RecoveryAdminGuard)
  @HttpCode(HttpStatus.OK)
  async rejectRecovery(
    @Param('id', ParseUUIDPipe) recoveryId: string,
    @Body() request: RecoveryAdminRequest,
    @Req() httpRequest: Request,
  ) {
    return this.adminRecoveryService.rejectRecovery({
      recoveryId,
      adminId: (httpRequest as any).recoveryAdminId,
      rejectionReason: request.rejectionReason ?? '',
    });
  }

  /**
   * Admin endpoint: Get all pending recovery requests
   */
  @Get('admin/pending')
  @UseGuards(RecoveryAdminGuard)
  async getPendingRecoveries() {
    return this.adminRecoveryService.getPendingRecoveries();
  }

  /**
   * Admin endpoint: Get recovery request history
   */
  @Get('admin/history/:id')
  @UseGuards(RecoveryAdminGuard)
  async getRecoveryHistory(@Param('id', ParseUUIDPipe) recoveryId: string) {
    return this.adminRecoveryService.getRecoveryHistory(recoveryId);
  }
}
