import { IsString } from 'class-validator';
import { ProjectSettingsDto } from './project-settings.dto';

export class CreateProjectDto extends ProjectSettingsDto {
  @IsString()
  name: string;

  @IsString()
  developerId: string;
}
