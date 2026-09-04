import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

export type ExportFormat = 'CSV' | 'JSON';

export type ExportJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export interface ExportFilters {
  senderWalletId?: string;
  receiverWalletId?: string;
  status?: string;
  assetType?: string;
  assetCode?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface CreateExportJobRequest {
  projectId: string;
  requestedBy?: string;
  format?: ExportFormat;
  filters?: ExportFilters;
}

export interface ExportJobSummary {
  id: string;
  projectId: string;
  format: ExportFormat;
  status: ExportJobStatus;
  rowCount: number;
  downloadUrl: string | null;
  expiresAt: Date | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * Minimum download link TTL: 5 minutes.
 * Maximum: 24 hours.
 * Default: 1 hour.
 */
const DEFAULT_DOWNLOAD_LINK_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DOWNLOAD_LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Signing secret for the download token.
 * Must be configured explicitly; we fail closed rather than silently using a default secret.
 */
function getSigningSecret(): string {
  const secret = process.env.EXPORT_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'EXPORT_SIGNING_SECRET is required to sign export download tokens',
    );
  }
  return secret;
}

/**
 * Generates a short-lived signed download token for a completed export job.
 *
 * Token format (URL-safe base64): <payload>.<signature>
 *   payload = base64url({ jobId, projectId, expiresAt })
 *   signature = HMAC-SHA256(payload, secret)
 */
export function generateDownloadToken(
  jobId: string,
  projectId: string,
  ttlMs: number = DEFAULT_DOWNLOAD_LINK_TTL_MS,
): { token: string; expiresAt: Date } {
  const effectiveTtl = Math.min(
    MAX_DOWNLOAD_LINK_TTL_MS,
    Math.max(MIN_DOWNLOAD_LINK_TTL_MS, ttlMs),
  );
  const expiresAt = new Date(Date.now() + effectiveTtl);

  const payloadObj = { jobId, projectId, expiresAt: expiresAt.toISOString() };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString(
    'base64url',
  );

  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');

  return { token: `${payloadB64}.${sig}`, expiresAt };
}

export interface DownloadTokenPayload {
  jobId: string;
  projectId: string;
  expiresAt: string;
}

/**
 * Verifies and decodes a signed download token.
 * Throws if the token is malformed, tampered, or expired.
 */
export function verifyDownloadToken(token: string): DownloadTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new BadRequestException('Invalid download token format');
  }

  const [payloadB64, sig] = parts;

  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');

  if (
    !crypto.timingSafeEqual(
      Buffer.from(sig, 'base64url'),
      Buffer.from(expectedSig, 'base64url'),
    )
  ) {
    throw new BadRequestException('Invalid download token signature');
  }

  let payload: DownloadTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    );
  } catch {
    throw new BadRequestException('Malformed download token payload');
  }

  if (new Date(payload.expiresAt) < new Date()) {
    throw new BadRequestException('Download token has expired');
  }

  return payload;
}

/**
 * TransactionExportService
 *
 * Provides async export of transaction data for a given project.
 *
 * Flow:
 *  1. `createExportJob` — creates a PENDING job record and fires off the
 *     export in the background (non-blocking to the HTTP caller).
 *  2. `getExportJob`    — polls job status by ID.
 *  3. `listExportJobs` — lists all jobs for a project (for admin/debug).
 *  4. `issueDownloadLink` — issues a fresh short-lived signed download URL
 *     for a completed job.
 *  5. `resolveDownload`   — verifies a token and returns the raw export data.
 *
 * On completion, the export content is stored in `downloadUrl` as a base64
 * data URI (internal storage).  The public API issues short-lived signed
 * tokens instead of exposing the raw data URI directly.  This decouples
 * token expiry from content storage.
 */
@Injectable()
export class TransactionExportService {
  private readonly logger = new Logger(TransactionExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates an async export job and begins processing in the background.
   * Returns immediately with the job ID so the caller can poll for status.
   */
  async createExportJob(request: CreateExportJobRequest): Promise<ExportJobSummary> {
    const { projectId, requestedBy, format = 'CSV', filters } = request;

    if (format !== 'CSV' && format !== 'JSON') {
      throw new BadRequestException(`Unsupported export format: ${format}. Use CSV or JSON.`);
    }

    const job = await this.prisma.transactionExportJob.create({
      data: {
        projectId,
        requestedBy: requestedBy ?? null,
        format,
        filters: filters ? (filters as any) : null,
        status: 'PENDING',
        rowCount: 0,
      },
    });

    this.logger.log(`Created export job ${job.id} for project ${projectId} (format: ${format})`);

    // Fire-and-forget: process the export asynchronously
    this.runExport(job.id, projectId, format, filters ?? {}).catch((err) => {
      this.logger.error(`Export job ${job.id} failed unexpectedly`, err);
    });

    return this.mapToSummary(job);
  }

  /**
   * Retrieves the status and result of an export job.
   * Throws NotFoundException if the job ID does not exist for the given project.
   */
  async getExportJob(jobId: string, projectId: string): Promise<ExportJobSummary> {
    const job = await this.prisma.transactionExportJob.findFirst({
      where: { id: jobId, projectId },
    });

    if (!job) {
      throw new NotFoundException(`Export job ${jobId} not found`);
    }

    return this.mapToSummary(job);
  }

  /**
   * Lists all export jobs for a project, newest first.
   */
  async listExportJobs(
    projectId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<{ jobs: ExportJobSummary[]; total: number }> {
    const [jobs, total] = await Promise.all([
      this.prisma.transactionExportJob.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.transactionExportJob.count({ where: { projectId } }),
    ]);

    return {
      jobs: jobs.map((j) => this.mapToSummary(j)),
      total,
    };
  }

  // ---------------------------------------------------------------------------
  // Private — export execution
  // ---------------------------------------------------------------------------

  /**
   * Runs the actual query and serialization in the background.
   * Updates job status throughout execution.
   *
   * The raw export content is stored as a base64 data URI in `downloadUrl`
   * for internal use. Clients receive short-lived signed tokens via
   * `issueDownloadLink` rather than this field directly.
   */
  private async runExport(
    jobId: string,
    projectId: string,
    format: ExportFormat,
    filters: ExportFilters,
  ): Promise<void> {
    // Mark RUNNING
    await this.prisma.transactionExportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    try {
      const transactions = await this.fetchTransactions(projectId, filters);
      const content = format === 'CSV'
        ? this.serializeCsv(transactions)
        : JSON.stringify(transactions, null, 2);

      const mimeType = format === 'CSV' ? 'text/csv' : 'application/json';
      // Store the data URI internally (not exposed directly to clients —
      // clients receive short-lived signed tokens from issueDownloadLink).
      const internalDataUri = `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
      // Default expiry aligned with the maximum allowed token TTL (24 h).
      const expiresAt = new Date(Date.now() + MAX_DOWNLOAD_LINK_TTL_MS);

      await this.prisma.transactionExportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          rowCount: transactions.length,
          downloadUrl: internalDataUri,
          expiresAt,
          completedAt: new Date(),
        },
      });

      this.logger.log(
        `Export job ${jobId} completed: ${transactions.length} rows, format=${format}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Export job ${jobId} failed: ${message}`);

      await this.prisma.transactionExportJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: message.substring(0, 500),
          completedAt: new Date(),
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public — signed download link issuance and resolution
  // ---------------------------------------------------------------------------

  /**
   * Issues a short-lived signed download token for a completed export job.
   *
   * @param jobId       The export job ID.
   * @param projectId   The project that owns the job (used for tenant scoping).
   * @param ttlMs       How long the token should be valid (default 1 h, capped at 24 h).
   * @returns           A signed token and its expiry time.
   */
  async issueDownloadLink(
    jobId: string,
    projectId: string,
    ttlMs: number = DEFAULT_DOWNLOAD_LINK_TTL_MS,
  ): Promise<{ token: string; expiresAt: Date; downloadUrl: string }> {
    const job = await this.getExportJob(jobId, projectId);

    if (job.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Export job ${jobId} is not completed (current status: ${job.status}). ` +
          'A download link can only be issued for completed jobs.',
      );
    }

    // Ensure the stored export data has not been purged.
    if (!job.downloadUrl) {
      throw new BadRequestException(
        `Export job ${jobId} has no stored data. The export may have expired.`,
      );
    }

    const { token, expiresAt } = generateDownloadToken(jobId, projectId, ttlMs);

    // Build a relative download URL path that clients can call.
    const downloadUrl = `/v1/transactions/export/${jobId}/download?token=${token}`;

    return { token, expiresAt, downloadUrl };
  }

  /**
   * Verifies a signed download token and returns the raw export content
   * together with metadata needed to set response headers.
   *
   * @param jobId  Export job ID (from route param — used to cross-check token).
   * @param token  The signed token issued by `issueDownloadLink`.
   * @returns      `{ content, mimeType, filename }` for the HTTP handler.
   */
  async resolveDownload(
    jobId: string,
    token: string,
  ): Promise<{ content: Buffer; mimeType: string; filename: string }> {
    const payload = verifyDownloadToken(token);

    if (payload.jobId !== jobId) {
      throw new BadRequestException(
        'Download token does not match the requested job ID',
      );
    }

    // Load the job — tenant check via projectId from the token payload.
    const job = await this.prisma.transactionExportJob.findFirst({
      where: { id: jobId, projectId: payload.projectId },
    });

    if (!job) {
      throw new NotFoundException(`Export job ${jobId} not found`);
    }

    if (job.status !== 'COMPLETED' || !job.downloadUrl) {
      throw new BadRequestException(
        `Export job ${jobId} is not available for download (status: ${job.status})`,
      );
    }

    // Parse the internally stored data URI.
    // Format: data:<mimeType>;base64,<base64data>
    const dataUriMatch = (job.downloadUrl as string).match(
      /^data:([^;]+);base64,(.+)$/s,
    );
    if (!dataUriMatch) {
      throw new BadRequestException(
        'Export data is malformed. Please re-create the export job.',
      );
    }

    const mimeType = dataUriMatch[1];
    const content = Buffer.from(dataUriMatch[2], 'base64');
    const ext = job.format === 'JSON' ? 'json' : 'csv';
    const filename = `export-${jobId}.${ext}`;

    return { content, mimeType, filename };
  }

  /**
   * Fetches transactions scoped to the project via their sender/receiver wallets.
   */
  private async fetchTransactions(
    projectId: string,
    filters: ExportFilters,
  ): Promise<any[]> {
    const where: Record<string, any> = {
      // Scope to project: wallets belong to the project's developer API keys.
      // We query via the wallet → user path, using the project's api key context.
      // For pragmatic scoping here we filter by any wallet that belongs to the project.
      OR: [
        {
          senderWallet: {
            user: {
              wallets: {
                some: {
                  apiKeys: {
                    some: { project: { id: projectId } },
                  },
                },
              },
            },
          },
        },
      ],
    };

    // Apply optional filters
    if (filters.senderWalletId) where.senderWalletId = filters.senderWalletId;
    if (filters.receiverWalletId) where.receiverWalletId = filters.receiverWalletId;
    if (filters.status) where.status = filters.status;
    if (filters.assetType) where.assetType = filters.assetType;
    if (filters.assetCode) where.assetCode = filters.assetCode;
    if (filters.createdAfter || filters.createdBefore) {
      where.createdAt = {};
      if (filters.createdAfter) where.createdAt.gte = new Date(filters.createdAfter);
      if (filters.createdBefore) where.createdAt.lte = new Date(filters.createdBefore);
    }

    return this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50_000, // Hard cap to prevent unbounded export
      select: {
        id: true,
        amount: true,
        assetType: true,
        assetCode: true,
        assetIssuer: true,
        senderWalletId: true,
        receiverWalletId: true,
        memo: true,
        status: true,
        stellarHash: true,
        stellarLedger: true,
        stellarFee: true,
        statusChangedAt: true,
        statusReason: true,
        submittedAt: true,
        confirmedAt: true,
        failedAt: true,
        idempotencyKey: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Converts an array of transaction records to RFC 4180-compliant CSV.
   */
  private serializeCsv(rows: any[]): string {
    if (rows.length === 0) return '';

    const headers = [
      'id',
      'amount',
      'assetType',
      'assetCode',
      'assetIssuer',
      'senderWalletId',
      'receiverWalletId',
      'memo',
      'status',
      'stellarHash',
      'stellarLedger',
      'stellarFee',
      'statusReason',
      'idempotencyKey',
      'statusChangedAt',
      'submittedAt',
      'confirmedAt',
      'failedAt',
      'createdAt',
      'updatedAt',
    ];

    const escape = (v: any): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Quote fields that contain commas, quotes, or newlines
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map((h) => escape(row[h])).join(','));
    }

    return lines.join('\n');
  }

  private mapToSummary(job: any): ExportJobSummary {
    return {
      id: job.id,
      projectId: job.projectId,
      format: job.format as ExportFormat,
      status: job.status as ExportJobStatus,
      rowCount: job.rowCount,
      downloadUrl: job.downloadUrl ?? null,
      expiresAt: job.expiresAt ?? null,
      errorMessage: job.errorMessage ?? null,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
      createdAt: job.createdAt,
    };
  }
}
