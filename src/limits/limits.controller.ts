import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

@Controller('limits')
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @Post()
  create(@Body() createLimitDto: CreateLimitDto) {
    return this.limitsService.create(createLimitDto);
  }

  @Get()
  findAll() {
    return this.limitsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.limitsService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateLimitDto: UpdateLimitDto) {
    return this.limitsService.update(+id, updateLimitDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.limitsService.remove(+id);
  }
}
