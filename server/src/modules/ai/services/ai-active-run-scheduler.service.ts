import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiActiveRunService } from './ai-active-run.service';

/**
 * Periodically removes AI Builder active runs whose heartbeat has gone stale.
 *
 * This prevents a crashed or abandoned stream from blocking a conversation forever.
 */
@Injectable()
export class AiActiveRunScheduler {
  private readonly logger = new Logger(AiActiveRunScheduler.name);

  constructor(private readonly aiActiveRunService: AiActiveRunService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupStaleRuns() {
    this.logger.log('Starting stale AI active-run cleanup');
    const removed = await this.aiActiveRunService.cleanupStaleRuns();
    this.logger.log(`Removed ${removed} stale active run(s)`);
  }
}
