import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateStatusHistoryEntry {
  paymentId: number;
  fromStatus: string | null;
  toStatus: string;
  reason?: string;
  changedBy?: string;
  metadata?: Record<string, any>;
}

export interface PaymentStatusHistoryEntry {
  id: string;
  paymentId: number;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  changedBy: string | null;
  changedAt: Date;
  metadata: Record<string, any> | null;
}

@Injectable()
export class PaymentStatusHistoryService {
  private readonly logger = new Logger(PaymentStatusHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a payment status transition in the history table.
   * Fire-and-forget: failures are logged and never surface to callers.
   */
  async recordStatusChange(entry: CreateStatusHistoryEntry): Promise<void> {
    try {
      await this.prisma.paymentStatusHistory.create({
        data: {
          paymentId: entry.paymentId,
          fromStatus: entry.fromStatus ?? null,
          toStatus: entry.toStatus,
          reason: entry.reason ?? null,
          changedBy: entry.changedBy ?? null,
          metadata: entry.metadata ?? undefined,
        },
      });

      this.logger.debug(
        `Recorded status change for payment #${entry.paymentId}: ${entry.fromStatus ?? 'null'} -> ${entry.toStatus}`,
      );
    } catch (error) {
      // Log but never throw - status history is best-effort and must not
      // prevent the primary operation from completing.
      this.logger.error(
        `Failed to record status history for payment #${entry.paymentId}: ${String(error)}`,
      );
    }
  }

  /**
   * Retrieves the complete status history for a payment.
   */
  async getHistory(paymentId: number): Promise<PaymentStatusHistoryEntry[]> {
    const records = await this.prisma.paymentStatusHistory.findMany({
      where: { paymentId },
      orderBy: { changedAt: 'asc' },
    });
    return records;
  }

  /**
   * Retrieves the last N status history entries across all payments.
   * Useful for recent activity dashboards.
   */
  async getRecentHistory(limit: number = 50): Promise<PaymentStatusHistoryEntry[]> {
    const records = await this.prisma.paymentStatusHistory.findMany({
      orderBy: { changedAt: 'desc' },
      take: limit,
    });
    return records;
  }
}
