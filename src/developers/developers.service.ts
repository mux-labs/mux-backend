import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDeveloperDto } from './dto/create-developer.dto';
import { UpdateDeveloperDto } from './dto/update-developer.dto';

@Injectable()
export class DevelopersService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateDeveloperDto) {
    return this.prisma.developer.create({ data: dto });
  }

  findAll() {
    return this.prisma.developer.findMany();
  }

  async findOne(id: string) {
    const developer = await this.prisma.developer.findUnique({ where: { id } });
    if (!developer) throw new NotFoundException(`Developer ${id} not found`);
    return developer;
  }

  async update(id: string, dto: UpdateDeveloperDto) {
    await this.findOne(id);
    return this.prisma.developer.update({ where: { id }, data: dto });
  }

  async findProjects(id: string) {
    await this.findOne(id);
    return this.prisma.project.findMany({ where: { developerId: id } });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.developer.delete({ where: { id } });
  }
}
