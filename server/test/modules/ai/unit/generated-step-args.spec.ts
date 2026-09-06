// server/test/modules/ai/unit/generated-step-args.spec.ts
//
// ADR-0048 follow-up: the generation engine's plan-time payloads are stored on Steps as
// props.generatedStep (persistProposedSteps). This pins the consumption policy that all
// executors share via resolveGeneratedStepArgs:
//   - first attempt only (a payload that failed once is replayed by the LLM, not itself),
//   - shape-gated per step type (malformed payload == absent payload -> LLM path, the same
//     fallback policy as plannedTable in executeCreateTableStep),
//   - semantically-wrong-but-well-shaped payloads (unknown componentId etc.) are NOT
//     filtered here — they flow into the executors' existing retryable guards.
import { resolveGeneratedStepArgs } from '@modules/ai/helpers/generated-step-args';

const stepWith = (type: string, props: any) => ({ type, props }) as any;

describe('resolveGeneratedStepArgs (ADR-0048 follow-up: deterministic consumption)', () => {
  it('returns the payload when it has the required args for the step type', () => {
    const payload = { componentId: 'c1', properties: { text: 'x' } };
    expect(resolveGeneratedStepArgs(stepWith('UpdateComponent', { generatedStep: payload }))).toEqual(payload);
  });

  it('returns null on any retry (previousError set) — retries must go back to the LLM', () => {
    const step = stepWith('UpdateComponent', { generatedStep: { componentId: 'c1' } });
    expect(resolveGeneratedStepArgs(step, 'previous attempt failed')).toBeNull();
  });

  it('returns null when props or generatedStep is missing or not a plain object', () => {
    expect(resolveGeneratedStepArgs(stepWith('UpdateComponent', undefined))).toBeNull();
    expect(resolveGeneratedStepArgs(stepWith('UpdateComponent', {}))).toBeNull();
    expect(resolveGeneratedStepArgs(stepWith('UpdateComponent', { generatedStep: 'updateComponent' }))).toBeNull();
    expect(
      resolveGeneratedStepArgs(stepWith('UpdateComponent', { generatedStep: [{ componentId: 'c1' }] }))
    ).toBeNull();
  });

  it('returns null when a required arg is missing or of the wrong kind', () => {
    expect(resolveGeneratedStepArgs(stepWith('DeleteComponent', { generatedStep: {} }))).toBeNull();
    expect(resolveGeneratedStepArgs(stepWith('DeleteComponent', { generatedStep: { componentId: 42 } }))).toBeNull();
    // UpdateQuery requires queryName: string + options: object
    expect(resolveGeneratedStepArgs(stepWith('UpdateQuery', { generatedStep: { queryName: 'q1' } }))).toBeNull();
    expect(
      resolveGeneratedStepArgs(stepWith('UpdateQuery', { generatedStep: { queryName: 'q1', options: [1, 2] } }))
    ).toBeNull();
  });

  it('returns null for step types the engine never produces payloads for', () => {
    expect(resolveGeneratedStepArgs(stepWith('CreateTable', { generatedStep: { table_name: 't' } }))).toBeNull();
    expect(resolveGeneratedStepArgs(stepWith('UpdateTable', { generatedStep: { table_name: 't' } }))).toBeNull();
  });
});
