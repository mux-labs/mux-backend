import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      developer: {
        findUnique: jest.fn(),
      },
      project: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProjectsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a project for an active developer', async () => {
    prisma.developer.findUnique.mockResolvedValue({ id: 'dev-123', status: 'ACTIVE', deletedAt: null });
    prisma.project.create.mockResolvedValue({ id: 'proj-123', name: 'Test Project', developerId: 'dev-123' });

    const result = await service.create({
      name: 'Test Project',
      developerId: 'dev-123',
    });

    expect(prisma.project.create).toHaveBeenCalledWith({
      data: {
        name: 'Test Project',
        developerId: 'dev-123',
      },
    });

    expect(result).toEqual({ id: 'proj-123', name: 'Test Project', developerId: 'dev-123' });
  });

  it('should throw NotFoundException when creating a project for missing developer', async () => {
    prisma.developer.findUnique.mockResolvedValue(null);

    await expect(
      service.create({
        name: 'New Project',
        developerId: 'missing-dev',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should throw UnauthorizedException when creating a project for inactive developer', async () => {
    prisma.developer.findUnique.mockResolvedValue({ id: 'dev-123', status: 'SUSPENDED', deletedAt: null });

    await expect(
      service.create({
        name: 'New Project',
        developerId: 'dev-123',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should update a project when developer owns it', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj-123', developerId: 'dev-123' });
    prisma.project.update.mockResolvedValue({ id: 'proj-123', name: 'Updated Project', developerId: 'dev-123' });

    const result = await service.update('proj-123', { name: 'Updated Project' }, 'dev-123');

    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'proj-123' }, data: { name: 'Updated Project' } });
    expect(result).toEqual({ id: 'proj-123', name: 'Updated Project', developerId: 'dev-123' });
  });

  it('should reject project updates when developer does not own project', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj-123', developerId: 'dev-123' });

    await expect(
      service.update('proj-123', { name: 'Updated Project' }, 'other-dev'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should remove a project when developer owns it', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj-123', developerId: 'dev-123' });
    prisma.project.delete.mockResolvedValue({ id: 'proj-123' });

    const result = await service.remove('proj-123', 'dev-123');

    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'proj-123' } });
    expect(result).toEqual({ id: 'proj-123' });
  });

  it('should reject project removal when developer does not own project', async () => {
    prisma.project.findUnique.mockResolvedValue({ id: 'proj-123', developerId: 'dev-123' });

    await expect(service.remove('proj-123', 'other-dev')).rejects.toThrow(UnauthorizedException);
  });
});
