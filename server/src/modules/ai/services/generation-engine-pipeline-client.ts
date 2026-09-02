import { Injectable, Logger } from '@nestjs/common';
import { parseEngineSSE } from './engine-sse-parser';
import { AiKeySettingsService } from './ai-key-settings.service';

/**
 * The per-request LLM provider config the server resolves (org BYOK via
 * `AiKeySettingsService.getEffectiveOrgConfig`, else the env fallback) and
 * posts to the engine (ADR-0038). Field-for-field the engine's
 * `EffectiveLlmConfig` (generation-engine/src/config/provider.ts) — a transit
 * mirror while #94's shared type isn't mergeable into this tree.
 */
export interface EngineLlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

/**
 * Caller-facing event union the pipeline run proxy yields. Mirrors the wire
 * contract of the engine's `POST /generate/run`
 * (generation-engine/src/routes/run-pipeline.ts), translated the same way
 * #91's GenerationEngineClient translates `/generate/prd`: engine event names
 * (`engine-done`/`engine-error`) are renamed so they can never collide with
 * the browser-facing events AiService emits over the same SSE channel
 * (`done`/`error` via AiUtilService.sendSSE).
 */
export type GenerationEnginePipelineEvent =
  | { type: 'stage'; stage: string }
  | { type: 'prd-chunk'; content: string }
  | { type: 'done'; artifacts: Record<string, unknown> }
  | { type: 'error'; message: string; stage?: string };

/**
 * One non-table step's pre-generated payload from POST /generate/steps (ADR-0048);
 * `index` is the step's position in the returned step plan.
 */
export interface EngineGeneratedStep {
  index: number;
  type: string;
  payload: Record<string, unknown>;
}

/** The part of /generate/steps' final artifacts the server's planner consumes (ADR-0048). */
export interface EngineStepsResult {
  steps: Array<{
    type: string;
    description: string;
    table?: unknown;
    seed_rows?: unknown[];
    phase?: string;
  }>;
  generatedSteps: EngineGeneratedStep[];
}

/**
 * Bounded worst case for the whole engine pipeline (up to six LLM calls). Beyond this
 * the server falls back in-process rather than hanging approvePrd's SSE channel.
 */
const STEPS_TIMEOUT_MS = 300_000;

/**
 * Idle-timeout: no event from the engine (not even a chunk) within this window
 * aborts the request. Same value and rationale as #91's GenerationEngineClient
 * (AC#3): guards "engine accepts the connection then goes silent".
 */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Server-side proxy client for the Generation engine's `POST /generate/run`
 * full-pipeline route (ticket #113, ADR-0027/0028). Talks HTTP+SSE to the
 * engine (ADR-0029: stateless, no shared process/DB) and mirrors the stream
 * event-by-event so the caller can forward it onto the existing browser SSE
 * channel (AiUtilService.initSSE/sendSSE) without buffering.
 *
 * Flag-guard shape (ADR-0036): `GENERATION_ENGINE_URL` unset means the engine
 * isn't deployed — callers check `isConfigured()` and fall back to the
 * in-process AIGateway path rather than fail generation entirely. Same guard
 * shape #91's GenerationEngineClient uses for `/generate/prd`.
 *
 * The terminal `done` event carries the engine's final structured artifacts
 * payload (`PipelineArtifacts`: classification, prd, lld, featurePlan,
 * entityToolCalls, stepPlan, evaluation). Persisting/acting on the non-PRD
 * artifacts (TooljetDB execution of the tool calls, step-list approval) is the
 * caller's concern (#111) — the engine is stateless and persists nothing.
 *
 * Transit note: #91's `generation-engine-client.ts` (the `/generate/prd`
 * proxy) is NOT in this tree — it lands with PR #91's merge and this class's
 * structure (idle timeout, terminal-event discipline, abort propagation)
 * deliberately mirrors it so the two can share helpers at rebase.
 */
@Injectable()
export class GenerationEnginePipelineClient {
  private readonly logger = new Logger(GenerationEnginePipelineClient.name);

  constructor(private readonly aiKeySettingsService: AiKeySettingsService) {}

  isConfigured(): boolean {
    return Boolean(process.env.GENERATION_ENGINE_URL);
  }

  /**
   * Plans the approved PRD's step list against POST /generate/steps (ADR-0048) and
   * returns the engine's step plan plus the non-table steps' pre-generated payloads.
   *
   * Throws on every failure mode — unreachable engine, non-200, missing effective org
   * LLM config (ADR-0038: resolved here, per request, before anything crosses the
   * wire), malformed response — so the CALLER (generateStepPlan) owns the
   * fallback-to-in-process policy (ADR-0048 decision 5); this client never hides a
   * failure.
   */
  async generateSteps(
    prd: string,
    lld: Record<string, unknown> | undefined,
    componentIndex: string | undefined,
    organizationId: string
  ): Promise<EngineStepsResult> {
    const baseUrl = process.env.GENERATION_ENGINE_URL;
    if (!baseUrl) {
      throw new Error('GenerationEnginePipelineClient: GENERATION_ENGINE_URL is not configured');
    }
    const orgConfig = await this.aiKeySettingsService.getEffectiveOrgConfig(organizationId);
    if (!orgConfig) {
      throw new Error('GenerationEnginePipelineClient: no effective org LLM config for step planning');
    }

    const llm: EngineLlmConfig = {
      provider: orgConfig.provider,
      model: orgConfig.model,
      apiKey: orgConfig.apiKey,
      ...(orgConfig.baseURL && { baseURL: orgConfig.baseURL }),
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/generate/steps`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.ENGINE_API_KEY && { Authorization: `Bearer ${process.env.ENGINE_API_KEY}` }),
        },
        body: JSON.stringify({
          prd,
          ...(lld && { lld }),
          ...(componentIndex && { componentIndex }),
          organizationId,
          llm,
        }),
        signal: AbortSignal.timeout(STEPS_TIMEOUT_MS),
      });
    } catch (error: any) {
      throw new Error(`GenerationEnginePipelineClient: engine unreachable (${error?.message || error})`);
    }

    if (!response.ok) {
      throw new Error(`GenerationEnginePipelineClient: engine responded ${response.status}`);
    }

    const payload = (await response.json()) as {
      artifacts?: { stepPlan?: { steps?: unknown }; generatedSteps?: unknown };
    };
    const steps = (payload as any)?.artifacts?.stepPlan?.steps;
    if (!Array.isArray(steps)) {
      throw new Error('GenerationEnginePipelineClient: engine returned no step plan');
    }

    return {
      steps: steps as EngineStepsResult['steps'],
      generatedSteps: Array.isArray((payload as any)?.artifacts?.generatedSteps)
        ? ((payload as any).artifacts.generatedSteps as EngineGeneratedStep[])
        : [],
    };
  }

  /**
   * Opens the SSE connection to `POST /generate/run` and yields translated
   * events as they arrive — no buffering, per ADR-0027/AC#2. `signal` lets the
   * caller abort the upstream request when the browser disconnects.
   */
  async *runPipeline(
    prompt: string,
    llm: EngineLlmConfig,
    organizationId: string,
    signal?: AbortSignal
  ): AsyncGenerator<GenerationEnginePipelineEvent> {
    const baseUrl = process.env.GENERATION_ENGINE_URL;
    if (!baseUrl) {
      throw new Error('GenerationEnginePipelineClient: GENERATION_ENGINE_URL is not configured');
    }

    const idleController = new AbortController();
    const idleTimer = setTimeout(() => idleController.abort(), IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
    const onExternalAbort = () => idleController.abort();
    signal?.addEventListener('abort', onExternalAbort);

    const resetIdleTimer = () => {
      idleTimer.refresh();
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/generate/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Shared secret required by the engine's auth middleware (ticket
          // #114, ADR-0032). Same env var the engine checks; unset here means
          // the engine rejects with 401/503 — surfaced as an engine error.
          ...(process.env.ENGINE_API_KEY && { Authorization: `Bearer ${process.env.ENGINE_API_KEY}` }),
        },
        body: JSON.stringify({ prompt, organizationId, llm }),
        signal: idleController.signal,
      });
    } catch (error: any) {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onExternalAbort);
      throw new Error(`GenerationEnginePipelineClient: engine unreachable (${error?.message || error})`);
    }

    if (!response.ok || !response.body) {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onExternalAbort);
      throw new Error(`GenerationEnginePipelineClient: engine responded ${response.status}`);
    }

    let sawTerminalEvent = false;

    try {
      for await (const event of parseEngineSSE(iterateWebStream(response.body))) {
        resetIdleTimer();

        if (event.type === 'stage') {
          const stage = (event.data as { stage?: unknown })?.stage;
          if (typeof stage === 'string') {
            yield { type: 'stage', stage };
          }
          continue;
        }

        if (event.type === 'prd-chunk') {
          const content = (event.data as { content?: string })?.content;
          if (typeof content === 'string') {
            yield { type: 'prd-chunk', content };
          }
          continue;
        }

        if (event.type === 'engine-done') {
          sawTerminalEvent = true;
          const artifacts = (event.data as { artifacts?: Record<string, unknown> })?.artifacts;
          yield { type: 'done', artifacts: artifacts ?? {} };
          return;
        }

        if (event.type === 'engine-error') {
          sawTerminalEvent = true;
          const message = (event.data as { message?: string })?.message || 'Generation engine reported an error';
          const stage = (event.data as { stage?: string })?.stage;
          yield { type: 'error', message, ...(stage && { stage }) };
          return;
        }
        // Unrecognized event types are ignored rather than surfaced — this
        // proxy only knows the route's documented contract.
      }
    } catch (error: any) {
      // Includes the idle-timeout abort: fetch/undici surface that as an
      // AbortError on the body reader, not as a rejected fetch() call.
      this.logger.error(`[GenerationEnginePipelineClient] stream read failed: ${error?.message}`, error?.stack);
      yield { type: 'error', message: 'Generation engine connection was lost' };
      return;
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    // Stream ended with neither engine-done nor engine-error: silence must
    // not be mistaken for success — a truncated run must not be reported as
    // `done`.
    if (!sawTerminalEvent) {
      yield { type: 'error', message: 'Generation engine stream ended unexpectedly' };
    }
  }
}

async function* iterateWebStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
