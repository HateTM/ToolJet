import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { dbTransactionWrap } from '@helpers/database.helper';
import { Artifact } from '@entities/artifact.entity';

@Injectable()
export class ArtifactRepository extends Repository<Artifact> {
  constructor(private dataSource: DataSource) {
    super(Artifact, dataSource.createEntityManager());
  }

  async createOne(artifact: Partial<Artifact>, manager?: EntityManager): Promise<Artifact> {
    return dbTransactionWrap((manager: EntityManager) => {
      return manager.save(manager.create(Artifact, artifact));
    }, manager || this.manager);
  }
}
