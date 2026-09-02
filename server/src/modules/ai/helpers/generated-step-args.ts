// ADR-0048 follow-up: plan-time payloads from the generation engine are stored on Steps
// as props.generatedStep (persistProposedSteps). This helper is the single seam executors
// use to consume them deterministically.
//
// Policy:
//  - First attempt only (previousError undefined): a payload that already failed once must
//    not be replayed — retries go back to the LLM with the error as feedback, the only path
//    that can produce a *different* result.
//  - Shape-gated: a payload missing the step type's required args is treated as absent
//    (advisory data, malformed -> LLM path), mirroring the plannedTable policy in
//    executeCreateTableStep. A well-shaped but semantically wrong payload (unknown
//    componentId, unsupported component type) is NOT filtered here: it flows into the
//    executor's existing retryable guards, which feed the error back to the LLM on retry.
import { Step } from '@entities/step.entity';

type ArgKind = 'string' | 'object' | 'array';

// Required top-level args per step type, as { arg: kind }. Optional args (UpdateComponent's
// properties/styles, MoveComponent's newParentComponentId, GenerateEvent's params) are
// deliberately absent: their absence is meaningful to the executor, not malformed.
// CreateTable/UpdateTable are excluded — their plan-time contract lives in plannedTable.
const REQUIRED_ARGS: Partial<Record<Step['type'], Record<string, ArgKind>>> = {
  CreateComponent: { type: 'string' },
  UpdateComponent: { componentId: 'string' },
  DeleteComponent: { componentId: 'string' },
  MoveComponent: { componentId: 'string' },
  CreateQuery: { name: 'string' },
  UpdateQuery: { queryName: 'string', options: 'object' },
  DeleteQuery: { queryName: 'string' },
  GenerateEvent: { targetName: 'string', eventId: 'string', actionId: 'string' },
};

const isPlainObject = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function resolveGeneratedStepArgs(
  step: Pick<Step, 'type' | 'props'>,
  previousError?: string
): Record<string, unknown> | null {
  if (previousError !== undefined) return null;

  const payload = step?.props?.generatedStep;
  if (!isPlainObject(payload)) return null;

  const required = REQUIRED_ARGS[step.type];
  if (!required) return null;

  for (const [arg, kind] of Object.entries(required)) {
    const value = (payload as Record<string, unknown>)[arg];
    if (kind === 'string' && typeof value !== 'string') return null;
    if (kind === 'object' && !isPlainObject(value)) return null;
    if (kind === 'array' && !Array.isArray(value)) return null;
  }

  return payload as Record<string, unknown>;
}
