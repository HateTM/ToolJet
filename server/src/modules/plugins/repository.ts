import { Plugin } from '@entities/plugin.entity';
import { Injectable } from '@nestjs/common';
import { DataSource, FindOptionsRelations, Repository } from 'typeorm';

@Injectable()
export class PluginsRepository extends Repository<Plugin> {
  constructor(private dataSource: DataSource) {
    super(Plugin, dataSource.createEntityManager());
  }
  findById(id: string, relations?: FindOptionsRelations<Plugin>): Promise<Plugin> {
    return this.findOne({ where: { id }, relations });
  }
}
