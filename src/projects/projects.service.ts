import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateProjectDto) {
    const developer = await this.prisma.developer.findUnique({
      where: { id: dto.developerId },
    });

    if (!developer || developer.deletedAt) {
      throw new NotFoundException(`Developer ${dto.developerId} not found`);
    }

    if (developer.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        `Developer ${dto.developerId} is not active`,
      );
    }

    return this.prisma.project.create({ data: dto });
  }

  findAll() {
    return this.prisma.project.findMany();
  }

  async findByDeveloper(developerId: string) {
    const developer = await this.prisma.developer.findUnique({
      where: { id: developerId },
    });

    if (!developer) {
      throw new NotFoundException(`Developer ${developerId} not found`);
    }

    return this.prisma.project.findMany({ where: { developerId } });
  }

  async findOne(id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async update(id: string, dto: UpdateProjectDto, developerId?: string) {
    const project = await this.findOne(id);

    if (developerId && project.developerId !== developerId) {
      throw new UnauthorizedException(
        'You do not have permission to update this project',
      );
    }

    if (dto.developerId && dto.developerId !== project.developerId) {
      const developer = await this.prisma.developer.findUnique({
        where: { id: dto.developerId },
      });

      if (!developer || developer.deletedAt) {
        throw new NotFoundException(`Developer ${dto.developerId} not found`);
      }

      if (developer.status !== 'ACTIVE') {
        throw new UnauthorizedException(
          `Developer ${dto.developerId} is not active`,
        );
      }
    }

    return this.prisma.project.update({ where: { id }, data: dto });
  }

  async remove(id: string, developerId?: string) {
    const project = await this.findOne(id);

    if (developerId && project.developerId !== developerId) {
      throw new UnauthorizedException(
        'You do not have permission to remove this project',
      );
    }

    return this.prisma.project.delete({ where: { id } });
  }
}
