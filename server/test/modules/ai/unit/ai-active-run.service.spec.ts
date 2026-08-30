import { ConflictException } from '@nestjs/common';
import { AiActiveRunService } from '@modules/ai/services/ai-active-run.service';

const buildMockRepository = () => ({
  findByConversationId: jest.fn(),
  beginRun: jest.fn(),
  touchRun: jest.fn(),
  endRun: jest.fn(),
  deleteStaleRuns: jest.fn(),
});

/** @group platform */
describe('AiActiveRunService', () => {
  it('begins a run through the repository', async () => {
    const repository = buildMockRepository();
    repository.beginRun.mockResolvedValue({ conversationId: 'conv-1' });
    const service = new AiActiveRunService(repository as any);

    const result = await service.beginRun('conv-1', 'user-1', 'org-1');

    expect(repository.beginRun).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(result).toEqual({ conversationId: 'conv-1' });
  });

  it('rejects a duplicate beginRun as a ConflictException', async () => {
    const repository = buildMockRepository();
    repository.beginRun.mockRejectedValue(
      new ConflictException('A generation is already in progress for this conversation')
    );
    const service = new AiActiveRunService(repository as any);

    await expect(service.beginRun('conv-1', 'user-1', 'org-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('touches a run through the repository', async () => {
    const repository = buildMockRepository();
    const service = new AiActiveRunService(repository as any);

    await service.touchRun('conv-1');

    expect(repository.touchRun).toHaveBeenCalledWith('conv-1');
  });

  it('ends a run through the repository', async () => {
    const repository = buildMockRepository();
    const service = new AiActiveRunService(repository as any);

    await service.endRun('conv-1');

    expect(repository.endRun).toHaveBeenCalledWith('conv-1');
  });

  it('returns null when no run exists', async () => {
    const repository = buildMockRepository();
    repository.findByConversationId.mockResolvedValue(null);
    const service = new AiActiveRunService(repository as any);

    const result = await service.findActiveRun('conv-1');

    expect(result).toBeNull();
  });

  it('returns the run when one exists', async () => {
    const repository = buildMockRepository();
    repository.findByConversationId.mockResolvedValue({ conversationId: 'conv-1' });
    const service = new AiActiveRunService(repository as any);

    const result = await service.findActiveRun('conv-1');

    expect(result).toEqual({ conversationId: 'conv-1' });
  });

  it('cleans up runs older than the 2-minute stale threshold', async () => {
    const repository = buildMockRepository();
    repository.deleteStaleRuns.mockResolvedValue(3);
    const service = new AiActiveRunService(repository as any);

    const removed = await service.cleanupStaleRuns();

    expect(removed).toBe(3);
    expect(repository.deleteStaleRuns).toHaveBeenCalled();
    const threshold = repository.deleteStaleRuns.mock.calls[0][0];
    expect(threshold).toBeInstanceOf(Date);
    expect(Date.now() - threshold.getTime()).toBeGreaterThanOrEqual(2 * 60 * 1000 - 1000);
    expect(Date.now() - threshold.getTime()).toBeLessThanOrEqual(2 * 60 * 1000 + 1000);
  });
});
