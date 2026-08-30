import { Injectable, ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AiActiveRun } from '@entities/ai_active_run.entity';

@Injectable()
export class AiActiveRunRepository extends Repository<AiActiveRun> {
  constructor(private dataSource: DataSource) {
    super(AiActiveRun, dataSource.createEntityManager());
  }

  async findByConversationId(conversationId: string): Promise<AiActiveRun | null> {
    return this.findOne({ where: { conversationId } });
  }

  async beginRun(run: Partial<AiActiveRun>): Promise<AiActiveRun> {
    try {
      const created = this.create(run);
      return await this.save(created);
    } catch (error) {
      if (error?.code === '23505' || error?.driverError?.code === '23505') {
        throw new ConflictException('A generation is already in progress for this conversation');
      }
      throw error;
    }
  }

  async touchRun(conversationId: string): Promise<void> {
    await this.update({ conversationId }, { lastHeartbeatAt: () => 'now()' });
  }

  async endRun(conversationId: string): Promise<void> {
    await this.delete({ conversationId });
  }

  async deleteStaleRuns(threshold: Date): Promise<number> {
    const result = await this.createQueryBuilder()
      .delete()
      .from(AiActiveRun)
      .where('last_heartbeat_at < :threshold', { threshold })
      .execute();

    return result.affected || 0;
  }
}
