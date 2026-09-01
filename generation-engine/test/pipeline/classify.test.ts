import { parseClassification, buildClassifyStage } from '../../src/pipeline/classify';
import { PipelineArtifacts, StageContext } from '../../src/pipeline/types';

describe('parseClassification', () => {
  it('accepts a well-formed payload', () => {
    expect(parseClassification({ intent: 'build_app', confidence: 0.9 })).toEqual({
      intent: 'build_app',
      confidence: 0.9,
    });
  });

  it('falls back to unsupported/0 for a non-object payload', () => {
    expect(parseClassification('not an object')).toEqual({ intent: 'unsupported', confidence: 0 });
    expect(parseClassification(null)).toEqual({ intent: 'unsupported', confidence: 0 });
  });

  it('falls back to unsupported/0 for an unknown intent', () => {
    expect(parseClassification({ intent: 'delete_everything', confidence: 0.9 })).toEqual({
      intent: 'unsupported',
      confidence: 0,
    });
  });

  it('clamps an out-of-range confidence into [0, 1]', () => {
    expect(parseClassification({ intent: 'build_app', confidence: 5 })).toEqual({
      intent: 'build_app',
      confidence: 1,
    });
    expect(parseClassification({ intent: 'build_app', confidence: -3 })).toEqual({
      intent: 'build_app',
      confidence: 0,
    });
  });

  it('defaults a missing confidence to 0', () => {
    expect(parseClassification({ intent: 'modify_app' })).toEqual({ intent: 'modify_app', confidence: 0 });
  });
});

describe('buildClassifyStage', () => {
  const ctx: StageContext = { organizationId: 'org-1' };
  const artifacts: PipelineArtifacts = { prompt: 'build a CRM' };

  it('calls deps.classify with the prompt and stores the parsed result', async () => {
    const classify = jest.fn().mockResolvedValue({ intent: 'build_app', confidence: 0.8 });
    const stage = buildClassifyStage({ classify });

    const result = await stage.run(artifacts, ctx);

    expect(classify).toHaveBeenCalledWith('build a CRM', ctx);
    expect(result.classification).toEqual({ intent: 'build_app', confidence: 0.8 });
    expect(result.prompt).toBe('build a CRM');
  });
});
