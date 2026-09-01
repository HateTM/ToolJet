import { runPipeline, PipelineStageError } from '../../src/pipeline/orchestrator';
import { makeTestCtx } from './ctx';

const ctx = makeTestCtx();
const baseArtifacts: PipelineArtifacts = { prompt: 'build a CRM' };

function fakeStage(name: string, fn: (a: PipelineArtifacts) => PipelineArtifacts): PipelineStage {
  return { name, run: async (a) => fn(a) };
}

describe('runPipeline', () => {
  it('threads artifacts through stages in order', async () => {
    const stages = [
      fakeStage('a', (a) => ({ ...a, prd: 'prd from a' })),
      fakeStage('b', (a) => ({ ...a, lld: { tables: [] } })),
    ];

    const result = await runPipeline(stages, baseArtifacts, ctx);

    expect(result.prd).toBe('prd from a');
    expect(result.lld).toEqual({ tables: [] });
    expect(result.prompt).toBe('build a CRM');
  });

  it('does not run later stages once an earlier one throws', async () => {
    const later = jest.fn(async (a: PipelineArtifacts) => a);
    const stages: PipelineStage[] = [
      fakeStage('boom', () => {
        throw new Error('stage exploded');
      }),
      { name: 'later', run: later },
    ];

    await expect(runPipeline(stages, baseArtifacts, ctx)).rejects.toThrow(PipelineStageError);
    expect(later).not.toHaveBeenCalled();
  });

  it('names the failing stage in the thrown error', async () => {
    const stages: PipelineStage[] = [
      fakeStage('classify', (a) => a),
      fakeStage('prd', () => {
        throw new Error('llm timeout');
      }),
    ];

    await expect(runPipeline(stages, baseArtifacts, ctx)).rejects.toMatchObject({
      stageName: 'prd',
      message: expect.stringContaining('llm timeout'),
    });
  });

  it('returns the initial artifacts unchanged when given no stages', async () => {
    const result = await runPipeline([], baseArtifacts, ctx);
    expect(result).toEqual(baseArtifacts);
  });
});
