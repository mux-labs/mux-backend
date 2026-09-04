import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { CreateApiChangelogDto } from './dto/create-api-changelog.dto';
import { ApiChangelog } from './entities/api-changelog.entity';
import { SafeLogger } from '../common/safe-logger';

@Injectable()
export class ApiChangelogService {
  private readonly logger = new SafeLogger(ApiChangelogService.name);
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient({} as any);
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  async create(dto: CreateApiChangelogDto): Promise<ApiChangelog> {
    if (!dto.version.match(/^\d+\.\d+\.\d+$/)) {
      throw new BadRequestException('Version must follow semver format (e.g., 1.2.0)');
    }

    try {
      const now = new Date();
      const entry = await this.prisma.apiChangelog.create({
        data: {
          version: dto.version,
          changeType: dto.changeType,
          category: dto.category,
          title: dto.title,
          description: dto.description,
          affectedEndpoints: dto.affectedEndpoints,
          migrationGuide: dto.migrationGuide,
          publishedAt: now,
        },
      });

      this.logger.log(`API changelog created: version ${dto.version}`);
      return this.mapToEntity(entry);
    } catch (error: any) {
      this.logger.error(`Failed to create changelog: ${error.message}`);
      throw error;
    }
  }

  async findAll(options?: {
    version?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: ApiChangelog[]; total: number }> {
    const where: Record<string, unknown> = {};

    if (options?.version) {
      where.version = options.version;
    }
    if (options?.category) {
      where.category = options.category;
    }

    const limit = Math.min(options?.limit ?? 20, 100);
    const offset = options?.offset ?? 0;

    const [entries, total] = await Promise.all([
      this.prisma.apiChangelog.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.apiChangelog.count({ where }),
    ]);

    return {
      data: entries.map(e => this.mapToEntity(e)),
      total,
    };
  }

  async findOne(id: string): Promise<ApiChangelog> {
    const entry = await this.prisma.apiChangelog.findUnique({
      where: { id },
    });

    if (!entry) {
      throw new NotFoundException(`Changelog entry ${id} not found`);
    }

    return this.mapToEntity(entry);
  }

  async update(id: string, dto: Partial<CreateApiChangelogDto>): Promise<ApiChangelog> {
    const entry = await this.findOne(id);

    if (dto.version && !dto.version.match(/^\d+\.\d+\.\d+$/)) {
      throw new BadRequestException('Version must follow semver format');
    }

    const updated = await this.prisma.apiChangelog.update({
      where: { id },
      data: {
        ...(dto.version && { version: dto.version }),
        ...(dto.changeType && { changeType: dto.changeType }),
        ...(dto.category && { category: dto.category }),
        ...(dto.title && { title: dto.title }),
        ...(dto.description && { description: dto.description }),
        ...(dto.affectedEndpoints && { affectedEndpoints: dto.affectedEndpoints }),
        ...(dto.migrationGuide !== undefined && { migrationGuide: dto.migrationGuide }),
      },
    });

    this.logger.log(`API changelog updated: ${id}`);
    return this.mapToEntity(updated);
  }

  async delete(id: string): Promise<void> {
    const entry = await this.findOne(id);

    await this.prisma.apiChangelog.delete({
      where: { id },
    });

    this.logger.log(`API changelog deleted: ${id}`);
  }

  private mapToEntity(prismaEntry: any): ApiChangelog {
    return {
      id: prismaEntry.id,
      version: prismaEntry.version,
      changeType: prismaEntry.changeType,
      category: prismaEntry.category,
      title: prismaEntry.title,
      description: prismaEntry.description,
      affectedEndpoints: prismaEntry.affectedEndpoints,
      migrationGuide: prismaEntry.migrationGuide,
      publishedAt: prismaEntry.publishedAt,
      createdAt: prismaEntry.createdAt,
      updatedAt: prismaEntry.updatedAt,
    };
  }
}
