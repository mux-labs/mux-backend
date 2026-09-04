import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

describe('Maintenance Mode - Integration Test', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('should allow GET requests even when maintenance is enabled', async () => {
    await prisma.maintenanceState.upsert({
      where: { id: 'global' },
      create: { id: 'global', enabled: true },
      update: { enabled: true },
    });

    const response = await request(app.getHttpServer()).get('/maintenance');
    expect(response.status).toBe(HttpStatus.OK);
  });

  it('should block mutating requests (POST/PATCH/DELETE) when maintenance is enabled', async () => {
    await prisma.maintenanceState.upsert({
      where: { id: 'global' },
      create: { id: 'global', enabled: true },
      update: { enabled: true },
    });

    const response = await request(app.getHttpServer())
      .post('/some-endpoint')
      .send({});

    expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.body).toMatchObject({
      statusCode: 503,
      error: 'Service Unavailable',
    });
  });

  it('should allow mutating requests when maintenance is disabled', async () => {
    await prisma.maintenanceState.upsert({
      where: { id: 'global' },
      create: { id: 'global', enabled: false },
      update: { enabled: false },
    });

    const response = await request(app.getHttpServer()).get('/maintenance');
    expect(response.status).toBe(HttpStatus.OK);
  });
});
