import { Module } from '@nestjs/common';
import { DevelopersService } from './developers.service';
import { DevelopersController } from './developers.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DevelopersController],
  providers: [DevelopersService],
  exports: [DevelopersService],
})
export class DevelopersModule {}
