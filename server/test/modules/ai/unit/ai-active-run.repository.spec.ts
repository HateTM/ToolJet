import { ConflictException } from '@nestjs/common';
import { AiActiveRunRepository } from '@modules/ai/repositories/ai-active-run.repository';

const buildMockDataSource = () => ({
  createEntityManager: jest.fn().mockReturnValue({}),
});

/** @group platform */
describe('AiActiveRunRepository.beginRun', () => {
  it('inserts a new active run', async () => {
    const repository = new AiActiveRunRepository(buildMockDataSource() as any);
    const run = { conversationId: 'conv-1', userId: 'user-1', organizationId: 'org-1' };
    const saved = { id: 'run-1', ...run };
    repository.create = jest.fn().mockReturnValue(run);
    repository.save = jest.fn().mockResolvedValue(saved);

    const result = await repository.beginRun(run);

    expect(repository.create).toHaveBeenCalledWith(run);
    expect(repository.save).toHaveBeenCalledWith(run);
    expect(result).toEqual(saved);
  });

  it('throws ConflictException on a duplicate conversation run', async () => {
    const repository = new AiActiveRunRepository(buildMockDataSource() as any);
    const run = { conversationId: 'conv-1', userId: 'user-1', organizationId: 'org-1' };
    const error = new Error('duplicate key value violates unique constraint');
    (error as any).code = '23505';
    repository.create = jest.fn().mockReturnValue(run);
    repository.save = jest.fn().mockRejectedValue(error);

    await expect(repository.beginRun(run)).rejects.toBeInstanceOf(ConflictException);
  });
});
