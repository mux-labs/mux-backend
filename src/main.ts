import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import requestLogger from './common/middleware/request-logging.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Attach request logging middleware early in the pipeline
  app.use(requestLogger as any);

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
