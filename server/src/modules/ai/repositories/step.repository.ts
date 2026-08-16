import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { dbTransactionWrap } from '@helpers/database.helper';
import { Step } from '@entities/step.entity';

@Injectable()
export class StepRepository extends Repository<Step> {
  constructor(private dataSource: DataSource) {
    super(Step, dataSource.createEntityManager());
  }

  async findByConversationId(conversationId: string): Promise<Step[]> {
    return await this.find({
      where: { conversationId },
      order: { order: 'ASC' },
    });
  }

  async createOne(step: Partial<Step>, manager?: EntityManager): Promise<Step> {
    return dbTransactionWrap((manager: EntityManager) => {
      return manager.save(manager.create(Step, step));
    }, manager || this.manager);
  }

  async updateOne(id: string, updatableData: Partial<Step>, manager?: EntityManager): Promise<void> {
    await dbTransactionWrap((manager: EntityManager) => {
      return manager.update(Step, id, updatableData);
    }, manager || this.manager);
  }
}
