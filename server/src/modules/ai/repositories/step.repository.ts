import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, MoreThan, Repository } from 'typeorm';
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

  async findById(id: string): Promise<Step> {
    return await this.findOne({ where: { id } });
  }

  // Every Step created by one approvePrd call (ADR-0004) shares that call's PRD-approval
  // messageId — the natural "this plan's execution" scope (ADR-0008). Sorted ascending;
  // callers that need to undo dependencies-last reverse it themselves.
  // The pending Steps a previewed-but-not-yet-approved plan left for one PRD message
  // (ticket #20). previewPlan serves them back if the user previews twice, and approvePrd
  // reuses them instead of re-running the planner — so what was previewed is what executes.
  async findPendingForMessage(conversationId: string, messageId: string): Promise<Step[]> {
    return await this.find({
      where: { conversationId, messageId, status: 'pending' },
      order: { order: 'ASC' },
    });
  }

  async findAfterOrder(conversationId: string, messageId: string, order: number): Promise<Step[]> {
    return await this.find({
      where: { conversationId, messageId, order: MoreThan(order) },
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
