import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';

@Controller('recovery')
export class RecoveryController {
  constructor(private readonly recoveryService: RecoveryService) {}

  @Post()
  create(@Body() createRecoveryDto: CreateRecoveryDto) {
    return this.recoveryService.create(createRecoveryDto);
  }

  @Get()
  findAll() {
    return this.recoveryService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.recoveryService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateRecoveryDto: UpdateRecoveryDto) {
    return this.recoveryService.update(id, updateRecoveryDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.recoveryService.remove(id);
  }
}
