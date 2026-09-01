import { PipelineArtifacts, PipelineStage, StageContext } from './types';

/**
 * Thrown when a stage fails, naming the stage so callers (and tests) don't have to
 * pattern-match the wrapped error to know which stage broke.
 */
export class PipelineStageError extends Error {
  readonly stageName: string;
  readonly cause: unknown;

  constructor(stageName: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Pipeline stage "${stageName}" failed: ${causeMessage}`);
    this.name = 'PipelineStageError';
    this.stageName = stageName;
    this.cause = cause;
  }
}

/**
 * Runs `stages` in order over `initial` artifacts, threading each stage's output into
 * the next stage's input. Deliberately linear (no branching/retry) per ADR-0028: the
 * pipeline's internal stage boundaries are free to evolve, but the sequence itself is
 * fixed once composed by the caller (see `./index.ts`'s `buildDefaultPipeline`).
 *
 * A failing stage short-circuits the run — no later stage sees partial/inconsistent
 * artifacts from a failed one.
 */
export async function runPipeline(
  stages: PipelineStage[],
  initial: PipelineArtifacts,
  ctx: StageContext
): Promise<PipelineArtifacts> {
  let artifacts = initial;

  for (const stage of stages) {
    try {
      artifacts = await stage.run(artifacts, ctx);
    } catch (err) {
      throw new PipelineStageError(stage.name, err);
    }
  }

  return artifacts;
}
