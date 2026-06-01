import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { LimitsService } from './limits.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';

@Controller('limits')
@UseGuards(ApiKeyGuard)
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @Post()
  create(@Body(new ValidationPipe({ whitelist: true })) dto: CreateLimitDto) {
    return this.limitsService.create(dto);
  }

  @Get()
  findAll() {
    return this.limitsService.findAll();
  }

  @Get('user/:userId')
  findByUser(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.limitsService.findByUser(userId);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.limitsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: UpdateLimitDto,
  ) {
    return this.limitsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.limitsService.remove(id);
  }
}
