import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DevelopersService } from './developers.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DevelopersService', () => {
  let service: DevelopersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      developer: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      project: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DevelopersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DevelopersService>(DevelopersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a developer record', async () => {
    prisma.developer.create.mockResolvedValue({
      id: 'dev-123',
      email: 'test@example.com',
    });
    const result = await service.create({
      name: 'Test',
      email: 'test@example.com',
    });

    expect(prisma.developer.create).toHaveBeenCalledWith({
      data: { name: 'Test', email: 'test@example.com' },
    });
    expect(result).toEqual({ id: 'dev-123', email: 'test@example.com' });
  });

  it('should return a developer by id', async () => {
    prisma.developer.findUnique.mockResolvedValue({
      id: 'dev-123',
      email: 'test@example.com',
    });
    const result = await service.findOne('dev-123');

    expect(prisma.developer.findUnique).toHaveBeenCalledWith({
      where: { id: 'dev-123' },
    });
    expect(result).toEqual({ id: 'dev-123', email: 'test@example.com' });
  });

  it('should list projects for a developer', async () => {
    prisma.developer.findUnique.mockResolvedValue({
      id: 'dev-123',
      email: 'test@example.com',
    });
    prisma.project.findMany.mockResolvedValue([
      { id: 'proj-123', name: 'Test Project', developerId: 'dev-123' },
    ]);

    const result = await service.findProjects('dev-123');

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { developerId: 'dev-123' },
    });
    expect(result).toEqual([
      { id: 'proj-123', name: 'Test Project', developerId: 'dev-123' },
    ]);
  });

  it('should throw NotFoundException when developer is missing', async () => {
    prisma.developer.findUnique.mockResolvedValue(null);
    await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
  });

  it('should update an existing developer', async () => {
    prisma.developer.findUnique.mockResolvedValue({
      id: 'dev-123',
      email: 'test@example.com',
    });
    prisma.developer.update.mockResolvedValue({
      id: 'dev-123',
      email: 'updated@example.com',
    });

    const result = await service.update('dev-123', {
      email: 'updated@example.com',
    });

    expect(prisma.developer.update).toHaveBeenCalledWith({
      where: { id: 'dev-123' },
      data: { email: 'updated@example.com' },
    });
    expect(result).toEqual({ id: 'dev-123', email: 'updated@example.com' });
  });

  it('should remove an existing developer', async () => {
    prisma.developer.findUnique.mockResolvedValue({
      id: 'dev-123',
      email: 'test@example.com',
    });
    prisma.developer.delete.mockResolvedValue({ id: 'dev-123' });

    const result = await service.remove('dev-123');

    expect(prisma.developer.delete).toHaveBeenCalledWith({
      where: { id: 'dev-123' },
    });
    expect(result).toEqual({ id: 'dev-123' });
  });
});
