import { Injectable } from '@nestjs/common';
import { AiActiveRunRepository } from '../repositories/ai-active-run.repository';
import { AiActiveRun } from '@entities/ai_active_run.entity';

/**
 * Per-conversation active-run registry for AI Builder.
 *
 * Tracks which conversations currently have an active generation stream so that
 * parallel generation requests can be rejected. Each run is heartbeated while
 * the stream is open; stale runs (no heartbeat within the threshold) can be
 * cleaned up independently.
 */
@Injectable()
export class AiActiveRunService {
  // Stale threshold: 2 minutes without a heartbeat.
  private static readonly STALE_THRESHOLD_MS = 2 * 60 * 1000;

  constructor(private readonly aiActiveRunRepository: AiActiveRunRepository) {}

  async beginRun(conversationId: string, userId: string, organizationId: string): Promise<AiActiveRun> {
    return this.aiActiveRunRepository.beginRun({
      conversationId,
      userId,
      organizationId,
    });
  }

  async touchRun(conversationId: string): Promise<void> {
    await this.aiActiveRunRepository.touchRun(conversationId);
  }

  async endRun(conversationId: string): Promise<void> {
    await this.aiActiveRunRepository.endRun(conversationId);
  }

  async findActiveRun(conversationId: string): Promise<AiActiveRun | null> {
    return this.aiActiveRunRepository.findByConversationId(conversationId);
  }

  async cleanupStaleRuns(): Promise<number> {
    const threshold = new Date(Date.now() - AiActiveRunService.STALE_THRESHOLD_MS);
    return this.aiActiveRunRepository.deleteStaleRuns(threshold);
  }
}
