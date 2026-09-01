import { parseEvaluationVerdict, buildEvaluateStage } from '../../src/pipeline/evaluate';
import { makeTestCtx } from './ctx';

describe('parseEvaluationVerdict', () => {
  it('accepts a well-formed pass verdict', () => {
    expect(parseEvaluationVerdict({ pass: true, reasons: [] })).toEqual({ pass: true, reasons: [] });
  });

  it('accepts a well-formed fail verdict with reasons', () => {
    expect(parseEvaluationVerdict({ pass: false, reasons: ['missing primary key'] })).toEqual({
      pass: false,
      reasons: ['missing primary key'],
    });
  });

  it('fails closed on a non-object payload', () => {
    expect(parseEvaluationVerdict('nope').pass).toBe(false);
    expect(parseEvaluationVerdict(null).pass).toBe(false);
  });

  it('fails closed when "pass" is missing or not boolean', () => {
    expect(parseEvaluationVerdict({ reasons: [] }).pass).toBe(false);
    expect(parseEvaluationVerdict({ pass: 'yes' }).pass).toBe(false);
  });

  it('drops non-string entries from reasons rather than failing the whole payload', () => {
    expect(parseEvaluationVerdict({ pass: true, reasons: ['ok', 42, null] })).toEqual({
      pass: true,
      reasons: ['ok'],
    });
  });

  it('defaults reasons to [] when absent', () => {
    expect(parseEvaluationVerdict({ pass: true })).toEqual({ pass: true, reasons: [] });
  });
});

describe('buildEvaluateStage', () => {
  const ctx = makeTestCtx();
  const artifacts: PipelineArtifacts = { prompt: 'x' };

  it('calls deps.judge with the full artifacts and stores the parsed verdict', async () => {
    const judge = jest.fn().mockResolvedValue({ pass: true, reasons: [] });
    const stage = buildEvaluateStage({ judge });

    const result = await stage.run(artifacts, ctx);

    expect(judge).toHaveBeenCalledWith(artifacts, ctx);
    expect(result.evaluation).toEqual({ pass: true, reasons: [] });
  });

  it('does not throw on a failing verdict — it records it and returns', async () => {
    const judge = jest.fn().mockResolvedValue({ pass: false, reasons: ['bad schema'] });
    const stage = buildEvaluateStage({ judge });

    const result = await stage.run(artifacts, ctx);

    expect(result.evaluation).toEqual({ pass: false, reasons: ['bad schema'] });
  });
});
