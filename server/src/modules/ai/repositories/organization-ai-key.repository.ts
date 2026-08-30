import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { OrganizationAiKey } from '@entities/organization_ai_key.entity';

@Injectable()
export class OrganizationAiKeyRepository extends Repository<OrganizationAiKey> {
  constructor(private dataSource: DataSource) {
    super(OrganizationAiKey, dataSource.createEntityManager());
  }

  findByOrganizationId(organizationId: string): Promise<OrganizationAiKey | null> {
    return this.findOne({ where: { organizationId } });
  }
}
