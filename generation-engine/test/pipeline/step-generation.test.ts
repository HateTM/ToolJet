import { buildStepGenerationStage } from '../../src/pipeline/step-generation';
import { PipelineArtifacts } from '../../src/pipeline/types';
import { makeTestCtx } from './ctx';

const ctx = makeTestCtx();

function artifactsWithSteps(steps: Array<Record<string, unknown>>): PipelineArtifacts {
  return { prompt: '', prd: 'PRD', stepPlan: { steps: steps as any } };
}

describe('step-generation stage', () => {
  it('requires artifacts.stepPlan (step-plan stage must run first)', async () => {
    const stage = buildStepGenerationStage({ generateStepPayload: jest.fn() });
    await expect(stage.run({ prompt: '' }, ctx)).rejects.toThrow('requires artifacts.stepPlan');
  });

  it('skips CreateTable steps and generates payloads for the rest, keeping the step index', async () => {
    const generateStepPayload = jest.fn().mockResolvedValue({ componentId: 'c-1', properties: { text: 'Hi' } });
    const stage = buildStepGenerationStage({ generateStepPayload });

    const result = await stage.run(
      artifactsWithSteps([
        { type: 'CreateTable', description: 'create users' },
        { type: 'UpdateComponent', description: 'retitle the heading' },
      ]),
      ctx
    );

    expect(generateStepPayload).toHaveBeenCalledTimes(1);
    expect(generateStepPayload.mock.calls[0][0]).toMatchObject({ type: 'UpdateComponent' });
    expect(generateStepPayload.mock.calls[0][1]).toBe(1);
    expect(result.generatedSteps).toEqual([
      { index: 1, type: 'UpdateComponent', payload: { componentId: 'c-1', properties: { text: 'Hi' } } },
    ]);
  });

  it('hard-fails on a non-object payload instead of storing a half-formed contract', async () => {
    const generateStepPayload = jest.fn().mockResolvedValue('prose, not JSON');
    const stage = buildStepGenerationStage({ generateStepPayload });

    await expect(
      stage.run(artifactsWithSteps([{ type: 'DeleteQuery', description: 'drop the customers query' }]), ctx)
    ).rejects.toThrow('non-object payload');
    expect(generateStepPayload).toHaveBeenCalledTimes(1);
  });

  it('hard-fails on a step type with no payload contract', async () => {
    const stage = buildStepGenerationStage({ generateStepPayload: jest.fn() });
    await expect(
      stage.run(artifactsWithSteps([{ type: 'SomeUnknownType', description: 'x' }]), ctx)
    ).rejects.toThrow('no payload contract');
  });
});
