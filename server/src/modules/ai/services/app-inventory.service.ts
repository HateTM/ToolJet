import { Injectable, Logger } from '@nestjs/common';
import { AppsRepository } from '@modules/apps/repository';
import { PageService } from '@modules/apps/services/page.service';
import { DataQueryRepository } from '@modules/data-queries/repository';
import { AiConversationRepository } from '../repositories/ai-conversation.repository';
import { AiConversationMessageRepository } from '../repositories/ai-conversation-message.repository';
import { StepRepository } from '../repositories/step.repository';
import { getEventIds } from '../helpers/widget-meta';

// Bounds on the assembled text. The inventory goes into the model's context on *every*
// Learn message (ADR-0011: assembled fresh, never indexed), so it has to stay small enough
// that a long-lived App with a lot of build history can't crowd out the conversation itself.
const MAX_PRD_SUMMARIES = 5;
const MAX_PRD_CHARS = 600;

const truncate = (text: string, limit: number): string => {
  const normalized = (text || '').trim().replace(/\s+/g, ' ');
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

/**
 * Assembles the `App inventory` (CONTEXT.md) a Learn conversation answers from: a distilled
 * snapshot of one App — its pages, the type and name of each page's components, its data
 * sources, its queries, plus a condensed summary of the PRDs that were actually approved and
 * built against it.
 *
 * Deliberately *not* an index: every call is a straight read against the same repositories the
 * rest of the app uses, and nothing is persisted or embedded (ADR-0011). Layout and styling are
 * omitted on purpose — a Learn conversation answers "what does my app do", not "what is this
 * button's border-radius".
 */
@Injectable()
export class AppInventoryService {
  private readonly logger = new Logger(AppInventoryService.name);

  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly pageService: PageService,
    private readonly dataQueryRepository: DataQueryRepository,
    private readonly aiConversationRepository: AiConversationRepository,
    private readonly aiConversationMessageRepository: AiConversationMessageRepository,
    private readonly stepRepository: StepRepository
  ) {}

  /**
   * Returns the inventory as the plain-text block that gets handed to the model. Text rather
   * than JSON: it's what the LLM reads, and a compact outline costs meaningfully fewer tokens
   * than the equivalent serialized object for the same content.
   *
   * `appVersionId` is passed in rather than resolved here — AiService already resolves "the"
   * version an AI Builder conversation is scoped to, and resolving it twice, independently,
   * is how the two would eventually disagree.
   */
  async assemble(appId: string, appVersionId: string): Promise<string> {
    const [app, pages, queries, buildHistory] = await Promise.all([
      this.appsRepository.findOneById(appId),
      this.pageService.findPagesForVersion(appVersionId),
      this.dataQueryRepository.getMany({ appVersionId }, ['dataSource']),
      this.summarizeBuildHistory(appId),
    ]);

    return [
      `App: ${app?.name || 'Untitled app'}`,
      this.renderPages(pages as any[]),
      this.renderDataSources(queries as any[]),
      this.renderQueries(queries as any[]),
      buildHistory,
    ].join('\n\n');
  }

  /**
   * The `Existing components already in this app` block an UpdateComponent step (ticket #66)
   * grounds itself in — unlike `renderPages`, this carries each component's real id, because
   * UpdateComponent has to reference one precisely (the same "never invent an id" contract
   * CreateComponent's pageId/queryName args already rely on), not just describe the app in
   * prose. Used both by the step planner (so it knows an UpdateComponent target exists at
   * all) and by UpdateComponent's own execution-time step context (so the id it emits is
   * checked against something real).
   */
  async renderComponentIndex(appVersionId: string): Promise<string> {
    const pages = await this.pageService.findPagesForVersion(appVersionId);
    const lines: string[] = [];
    for (const page of (pages as any[]) || []) {
      for (const [id, entry] of Object.entries(page.components || {}) as Array<[string, any]>) {
        // Real event ids (ticket #67) so an UpdateComponent step's event patch is grounded
        // in what the component actually exposes, the same "copied verbatim, never invented"
        // contract the id itself already gets — e.g. Table components list "onRowClicked",
        // which is what stops the model from guessing the plausible-but-wrong "onRowClick".
        const eventIds = getEventIds(entry?.type);
        const eventsSuffix = eventIds.length ? `, events: ${eventIds.join(', ')}` : '';
        lines.push(`- ${entry?.type} "${entry?.name}" (id: ${id}, page: "${page.name}"${eventsSuffix})`);
      }
    }
    if (!lines.length) return 'Existing components already in this app: none yet.';
    return ['Existing components already in this app:', ...lines].join('\n');
  }

  /**
   * The `Existing queries already in this app` block an UpdateQuery step (ticket #67)
   * grounds itself in — mirrors renderComponentIndex's reasoning: UpdateQuery has to
   * reference a real query id precisely, not just describe the app in prose.
   */
  async renderQueryIndex(appVersionId: string): Promise<string> {
    const queries = await this.dataQueryRepository.getMany({ appVersionId }, ['dataSource']);
    if (!queries?.length) return 'Existing queries already in this app: none yet.';
    const lines = (queries as any[]).map((query) => {
      const operation = query.options?.operation;
      const source = query.dataSource?.name ? ` on ${query.dataSource.name}` : '';
      return `- "${query.name}" (id: ${query.id}${source}${operation ? `, ${operation}` : ''})`;
    });
    return ['Existing queries already in this app:', ...lines].join('\n');
  }

  private renderPages(pages: any[]): string {
    if (!pages?.length) return 'Pages: none yet.';

    const lines = pages.map((page) => {
      // getAllComponents returns a { [componentId]: { name, type, ... } } map, so the
      // components are the map's values, not the page's own array.
      const components = Object.values(page.components || {}) as Array<{ name?: string; type?: string }>;
      if (!components.length) return `- ${page.name} (no components yet)`;
      const rendered = components.map((component) => `${component.type} "${component.name}"`).join(', ');
      return `- ${page.name}: ${rendered}`;
    });

    return ['Pages (with the components on each):', ...lines].join('\n');
  }

  /**
   * The App's data sources as reached *through* its queries. A data source with no query
   * against it isn't part of what this app does, which is what a Learn conversation answers.
   */
  private renderDataSources(queries: any[]): string {
    const byId = new Map<string, { name: string; kind: string }>();
    for (const query of queries || []) {
      if (query?.dataSource && !byId.has(query.dataSource.id)) {
        byId.set(query.dataSource.id, { name: query.dataSource.name, kind: query.dataSource.kind });
      }
    }
    if (!byId.size) return 'Data sources: none in use.';

    const lines = [...byId.values()].map((dataSource) => `- ${dataSource.name} (${dataSource.kind})`);
    return ['Data sources in use:', ...lines].join('\n');
  }

  private renderQueries(queries: any[]): string {
    if (!queries?.length) return 'Queries: none yet.';

    const lines = queries.map((query) => {
      const operation = query.options?.operation;
      const source = query.dataSource?.name ? ` on ${query.dataSource.name}` : '';
      return `- ${query.name}${source}${operation ? ` (${operation})` : ''}`;
    });
    return ['Queries:', ...lines].join('\n');
  }

  /**
   * Condensed summaries of the PRDs that were actually approved for this App, newest first —
   * the "summary of its own Generate conversation history" half of the inventory. Approval is
   * read off the Steps: `approvePrd` stamps every Step it generates with the approved PRD
   * message's id (ADR-0004), so a message with Steps against it is exactly a PRD that was
   * approved, and one without is a proposal the user never accepted.
   *
   * Scoped to the App, not to the asking user: the question is "what has been built here",
   * and a teammate's approved build changed this App just as much as the asker's own.
   */
  private async summarizeBuildHistory(appId: string): Promise<string> {
    const conversations = await this.aiConversationRepository.findAllByAppAndType(appId, 'generate');

    const summaries: string[] = [];
    for (const conversation of conversations) {
      const steps = await this.stepRepository.findByConversationId(conversation.id);
      if (!steps.length) continue;

      const stepsByMessage = new Map<string, typeof steps>();
      for (const step of steps) {
        stepsByMessage.set(step.messageId, [...(stepsByMessage.get(step.messageId) || []), step]);
      }

      for (const [messageId, messageSteps] of stepsByMessage) {
        const prdMessage = await this.aiConversationMessageRepository.findMessageById(messageId);
        if (!prdMessage?.content) continue;

        const built = messageSteps
          .filter((step) => step.status === 'succeeded')
          .map((step) => step.description)
          .join('; ');

        summaries.push(
          [
            `- PRD: ${truncate(prdMessage.content, MAX_PRD_CHARS)}`,
            `  Built: ${built || 'nothing (no step completed)'}`,
          ].join('\n')
        );
      }
    }

    if (!summaries.length) return 'Past approved builds: none — nothing has been built from a PRD in this app yet.';

    return ['Past approved builds (most recent conversations first):', ...summaries.slice(0, MAX_PRD_SUMMARIES)].join(
      '\n'
    );
  }
}
