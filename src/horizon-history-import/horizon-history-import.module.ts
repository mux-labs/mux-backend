import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HorizonHistoryImportService } from './horizon-history-import.service';
import { HorizonHistoryImportController } from './horizon-history-import.controller';

@Module({
  imports: [PrismaModule],
  controllers: [HorizonHistoryImportController],
  providers: [HorizonHistoryImportService],
  exports: [HorizonHistoryImportService],
})
export class HorizonHistoryImportModule {}
