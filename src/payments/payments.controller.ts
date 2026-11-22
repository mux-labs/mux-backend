import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';

/**
 * #972 — All mutations and queries are scoped to the authenticated developer's
 * namespace via the API key context injected by ApiKeyGuard.
 *
 * Security invariants:
 *  - POST /payments:  developerOwnerId is stamped from the API key context,
 *    not from the request body, so callers cannot spoof ownership.
 *  - GET  /payments:  results are filtered to the authenticated developer.
 *  - GET  /payments/:id: 404 is returned for records outside the developer scope.
 *  - PATCH /payments/:id: ownership is re-verified before any mutation.
 *  - DELETE /payments/:id: ownership is re-verified before any mutation.
 *
 * #1112 — The developer owner is resolved solely from the API key context. If
 * it cannot be resolved, the request is rejected (fail closed) rather than
 * falling back to any client-supplied value.
 *
 * #1273 — The path id is passed through as a string (matching findOne/remove)
 * rather than coerced with Number(), which would turn '1e2' into 100, '01'
 * into 1, and a UUID into NaN.
 */
@Controller('payments')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @SensitiveEndpoint()
  create(@Body() createPaymentDto: CreatePaymentDto, @Req() req: Request) {
    // Stamp the developer owner from the authenticated API key — not from the
    // request body — so callers cannot claim a different developer's namespace.
    const developerOwnerId: string | undefined = (req as any).apiKeyContext
      ?.developer?.id;

    if (!developerOwnerId) {
      throw new UnauthorizedException(
        'Unable to resolve developer from API key context',
      );
    }

    return this.paymentsService.create({
      ...createPaymentDto,
      developerOwnerId,
    });
  }

  @Get()
  findAll(@Req() req: Request) {
    const developerOwnerId: string | undefined = (req as any).apiKeyContext
      ?.developer?.id;
    return this.paymentsService.findAll(developerOwnerId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request) {
    const developerOwnerId: string | undefined = (req as any).apiKeyContext
      ?.developer?.id;
    return this.paymentsService.findOne(id, developerOwnerId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updatePaymentDto: UpdatePaymentDto,
    @Req() req: Request,
  ) {
    const developerOwnerId: string | undefined = (req as any).apiKeyContext
      ?.developer?.id;
    return this.paymentsService.update(id, updatePaymentDto, developerOwnerId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request) {
    const developerOwnerId: string | undefined = (req as any).apiKeyContext
      ?.developer?.id;
    return this.paymentsService.remove(id, developerOwnerId);
  }
}
