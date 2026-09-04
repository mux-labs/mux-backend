import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import {
  TenantScopeGuard,
  TenantScoped,
} from '../common/guards/tenant-scope.guard';

@Controller('projects')
@UseGuards(TenantScopeGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto);
  }

  @Get()
  findAll(@Query('developerId') developerId?: string) {
    if (developerId) return this.projectsService.findByDeveloper(developerId);
    return this.projectsService.findAll();
  }

  @Get(':id')
  @TenantScoped('id')
  findOne(@Param('id') id: string) {
    return this.projectsService.findOne(id);
  }

  @Patch(':id')
  @TenantScoped('id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @Query('developerId') developerId?: string,
  ) {
    return this.projectsService.update(id, dto, developerId);
  }

  @Delete(':id')
  @TenantScoped('id')
  remove(@Param('id') id: string, @Query('developerId') developerId?: string) {
    return this.projectsService.remove(id, developerId);
  }
}
