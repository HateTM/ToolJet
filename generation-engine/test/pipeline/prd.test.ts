import { buildPrdStageInput, buildPrdStage } from '../../src/pipeline/prd';
import { PipelineArtifacts, StageContext } from '../../src/pipeline/types';

describe('buildPrdStageInput', () => {
  it('returns the prompt unchanged when there is no classification', () => {
    expect(buildPrdStageInput({ prompt: 'build a CRM' })).toBe('build a CRM');
  });

  it('appends the classification when present', () => {
    const input = buildPrdStageInput({
      prompt: 'build a CRM',
      classification: { intent: 'build_app', confidence: 0.8 },
    });
    expect(input).toContain('build a CRM');
    expect(input).toContain('build_app');
    expect(input).toContain('0.8');
  });
});

describe('buildPrdStage', () => {
  const ctx: StageContext = { organizationId: 'org-1' };
  const artifacts: PipelineArtifacts = { prompt: 'build a CRM' };

  it('calls deps.generatePrd with the assembled input and stores the result', async () => {
    const generatePrd = jest.fn().mockResolvedValue('# PRD\n...');
    const stage = buildPrdStage({ generatePrd });

    const result = await stage.run(artifacts, ctx);

    expect(generatePrd).toHaveBeenCalledWith('build a CRM', ctx);
    expect(result.prd).toBe('# PRD\n...');
  });
});
