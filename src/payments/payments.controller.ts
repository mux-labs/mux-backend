import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentDryRunResponseDto } from './dto/payment-dry-run-response.dto';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PaymentsFilterDto } from './dto/payments-filter.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import { PaginationDto } from '../common/dto/pagination.dto';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';

@ApiTags('payments')
@Controller('payments')
@UseGuards(ApiKeyGuard, RateLimitGuard, FeatureFlagGuard)
@FeatureFlag('payments_api')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiOperation({
    summary: 'Create a new payment',
    description:
      'Create a new payment between wallets. Requires API key authentication. Rate limited to prevent abuse. Emits payment.created event on success. Pass an idempotencyKey to safely retry without creating a duplicate payment — replaying the same key returns the original payment.',
  })
  @ApiBody({
    type: CreatePaymentDto,
    examples: {
      default: {
        value: {
          walletId: '123e4567-e89b-12d3-a456-426614174000',
          receiverWalletId: '123e4567-e89b-12d3-a456-426614174001',
          amount: 100.5,
          currency: 'USD',
          description: 'Payment for services',
          fromId: 1,
          toId: 2,
          idempotencyKey: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'Payment created successfully. Emits payment.created domain event.',
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input.' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid API key.',
  })
  @ApiResponse({
    status: 422,
    description:
      'Daily spending limit exceeded for the sender wallet - payment rejected before submission.',
  })
  @Post()
  @SensitiveEndpoint()
  create(@Body() createPaymentDto: CreatePaymentDto) {
    return this.paymentsService.create(createPaymentDto);
  }

  @ApiOperation({
    summary: 'Validate a payment without creating or submitting it',
    description:
      'Runs the same wallet-state, self-payment, receiver, and payment-limit checks as payment creation. No payment is persisted, no transaction is signed or submitted, and no domain event is emitted.',
  })
  @ApiBody({ type: CreatePaymentDto })
  @ApiResponse({
    status: 200,
    description: 'The payment passed all pre-creation checks.',
    type: PaymentDryRunResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid input or inactive sender wallet.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid API key.',
  })
  @ApiResponse({
    status: 404,
    description: 'Sender or receiver wallet not found.',
  })
  @ApiResponse({
    status: 422,
    description: 'The payment exceeds a configured wallet limit.',
  })
  @Post('dry-run')
  @HttpCode(HttpStatus.OK)
  @SensitiveEndpoint()
  dryRun(@Body() createPaymentDto: CreatePaymentDto) {
    return this.paymentsService.dryRun(createPaymentDto);
  }

  @ApiOperation({
    summary: 'Create a batch of payments',
    description:
      'Submit multiple payments in a single request. The payload must contain at least one payment; an empty array is rejected with 400.',
  })
  @ApiBody({ type: BatchPaymentDto })
  @ApiResponse({
    status: 201,
    description: 'All payments in the batch were created successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request – empty batch or invalid payment data.',
    example: {
      statusCode: 400,
      message: ['payments must not be empty'],
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized – missing or invalid API key.',
  })
  @Post('batch')
  @SensitiveEndpoint()
  createBatch(@Body() batchPaymentDto: BatchPaymentDto) {
    return this.paymentsService.createBatch(batchPaymentDto);
  }

  @ApiOperation({
    summary: 'List all payments with pagination and filtering',
    description:
      'Retrieve paginated list of payments. Requires API key authentication. Supports filtering by status.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number (starting from 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 20,
    description: 'Items per page (max 100)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'CONFIRMED', 'FAILED'],
    description: 'Filter by payment status',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of payments.' })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid pagination or filter params.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid API key.',
  })
  @Get()
  findAll(
    @Query() pagination: PaginationDto,
    @Query() filters: PaymentsFilterDto,
  ) {
    return this.paymentsService.findAll(pagination, filters);
  }

  @ApiOperation({
    summary: 'Get a single payment by ID',
    description:
      'Retrieve a specific payment. Requires API key authentication.',
  })
  @ApiParam({ name: 'id', description: 'Payment ID' })
  @ApiResponse({ status: 200, description: 'Payment found.' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid API key.',
  })
  @ApiResponse({ status: 404, description: 'Payment not found.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paymentsService.findOne(id);
  }

  @ApiOperation({
    summary: 'Update a payment',
    description:
      'Update payment status or description. Valid status transitions: PENDING→CONFIRMED, PENDING→FAILED. Emits payment.completed or payment.failed event on status transition. Requires API key authentication.',
  })
  @ApiParam({ name: 'id', description: 'Payment ID' })
  @ApiBody({
    type: UpdatePaymentDto,
    examples: {
      default: {
        value: {
          status: 'CONFIRMED',
          description: 'Updated description',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Payment updated successfully. Emits payment.completed or payment.failed event if status changed.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid status transition.',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid API key.',
  })
  @ApiResponse({ status: 404, description: 'Payment not found.' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updatePaymentDto: UpdatePaymentDto) {
    return this.paymentsService.update(id, updatePaymentDto);
  }

  @ApiOperation({
    summary: 'Delete a payment',
    description: 'Delete a payment. Requires API key authentication.',
  })
  @ApiParam({ name: 'id', description: 'Payment ID' })
  @ApiResponse({ status: 200, description: 'Payment deleted successfully.' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid API key.',
  })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paymentsService.remove(id);
  }
}
