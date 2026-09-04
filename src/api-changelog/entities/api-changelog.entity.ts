import { ChangeType, ChangeCategory } from '../domain/api-changelog.model';

export class ApiChangelog {
  id: string;
  version: string;
  changeType: ChangeType;
  category: ChangeCategory;
  title: string;
  description: string;
  affectedEndpoints?: string[] | null;
  migrationGuide?: string | null;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
