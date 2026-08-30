import { Injectable } from '@nestjs/common';

export type FeasibilityVerdict =
  | { type: 'feasible' }
  | { type: 'infeasible'; messageForUser: string }
  | { type: 'noData'; recommendations: string[] };

export type InventoryNames = {
  pages: string[];
  components: string[];
  queries: string[];
  dataSources: string[];
};

const BUILD_INTENT_KEYWORDS = [
  'build',
  'create',
  'make',
  'add',
  'design',
  'generate',
  'app',
  'application',
  'page',
  'pages',
  'table',
  'tables',
  'form',
  'forms',
  'button',
  'buttons',
  'chart',
  'charts',
  'query',
  'queries',
  'dashboard',
  'crm',
  'tracker',
  'workflow',
  'inventory',
  'customer',
  'order',
  'support',
  'ticket',
  'lead',
  'contact',
  'product',
];

const NO_DATA_RECOMMENDATIONS = [
  'Describe the app you want to build, for example: "Build a customer CRM with a contacts table and a deals page".',
  'Refer to existing pages or components by name, for example: "Add a search input to the Orders page".',
  'Switch to Learn mode if you want to ask questions about the current app instead.',
];

/**
 * Determines whether a Generate-conversation request is buildable before any LLM call
 * or plan generation happens.
 *
 * The check is deterministic and based on the freshly-assembled App inventory:
 * - Feasible: the request mentions an existing page/component/query/data source,
 *   or contains clear build intent keywords.
 * - Infeasible: the request names specific entities that do not exist in the app.
 * - NoData: the request is too vague to act on (empty, too short, or neither names
 *   nor build keywords).
 */
@Injectable()
export class AiFeasibilityService {
  assess(requestText: string, inventory: string, references?: any[]): FeasibilityVerdict {
    const text = (requestText ?? '').trim();
    const names = this.parseInventoryNames(inventory ?? '');

    // Explicit @-mentions: if the user pointed at something real, trust it.
    if (Array.isArray(references) && references.length > 0) {
      const referenceEntries = references.filter(
        (ref) => ref && typeof ref === 'object' && typeof ref.name === 'string' && ref.name.trim()
      );
      const mentionedNamesLower = new Set(referenceEntries.map((ref) => ref.name.trim().toLowerCase()));
      const knownNames = this.allNamesLowercased(names);
      const anyKnown = [...mentionedNamesLower].some((name) => knownNames.has(name));
      if (anyKnown) return { type: 'feasible' };

      // User explicitly referenced something, but nothing matches the inventory.
      return {
        type: 'infeasible',
        messageForUser: this.buildInfeasibleMessage(
          referenceEntries.map((ref) => ref.name.trim()),
          names
        ),
      };
    }

    if (text.length === 0) {
      return { type: 'noData', recommendations: NO_DATA_RECOMMENDATIONS };
    }

    const normalizedText = this.normalize(text);

    if (normalizedText.length < 10) {
      return { type: 'noData', recommendations: NO_DATA_RECOMMENDATIONS };
    }

    const knownNames = this.allNamesLowercased(names);

    // Explicit entity references: "the Dashboard page", "on the Orders table", etc.
    const explicitReferences = this.extractExplicitEntityReferences(text);
    const unknownExplicit = explicitReferences.filter((name) => !knownNames.has(name.toLowerCase()));
    if (unknownExplicit.length > 0) {
      return {
        type: 'infeasible',
        messageForUser: this.buildInfeasibleMessage(unknownExplicit, names),
      };
    }

    // If the request names something that exists in the app, it's actionable.
    if (this.textMentionsAnyName(normalizedText, knownNames)) {
      return { type: 'feasible' };
    }

    // Clear build intent without needing existing names (new app from scratch).
    if (this.hasBuildIntent(normalizedText)) {
      return { type: 'feasible' };
    }

    // If the user used quoted names that don't match anything, treat it as a request
    // for non-existent entities.
    const quotedCandidates = this.extractQuotedNames(text);
    const unknownQuoted = quotedCandidates.filter((name) => !knownNames.has(name.toLowerCase()));
    if (unknownQuoted.length > 0) {
      return {
        type: 'infeasible',
        messageForUser: this.buildInfeasibleMessage(unknownQuoted, names),
      };
    }

    // Otherwise we don't have enough to go on.
    return { type: 'noData', recommendations: NO_DATA_RECOMMENDATIONS };
  }

  parseInventoryNames(inventory: string): InventoryNames {
    const names: InventoryNames = { pages: [], components: [], queries: [], dataSources: [] };

    const lines = inventory.split('\n');
    let section: 'pages' | 'queries' | 'sources' | 'history' | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        section = null;
        continue;
      }

      if (line.startsWith('Pages (') || line === 'Pages:') {
        section = 'pages';
        continue;
      }
      if (line.startsWith('Queries:')) {
        section = 'queries';
        continue;
      }
      if (line.startsWith('Data sources in use:') || line.startsWith('Data sources:')) {
        section = 'sources';
        continue;
      }
      if (line.startsWith('Past approved builds')) {
        section = 'history';
        continue;
      }

      if (!line.startsWith('- ')) continue;
      const item = line.slice(2).trim();

      switch (section) {
        case 'pages':
          this.parsePageLine(item, names);
          break;
        case 'queries':
          this.parseQueryLine(item, names);
          break;
        case 'sources':
          this.parseSourceLine(item, names);
          break;
      }
    }

    return names;
  }

  private parsePageLine(item: string, names: InventoryNames) {
    // "PageName: Type \"Name\", Type \"Name\"" or "PageName (no components yet)"
    const colonIndex = item.indexOf(':');
    if (colonIndex === -1) {
      if (!item.includes('(no components yet)')) return;
      const pageName = item.replace('(no components yet)', '').trim();
      if (pageName) names.pages.push(pageName);
      return;
    }

    const pageName = item.slice(0, colonIndex).trim();
    if (pageName) names.pages.push(pageName);

    const rest = item.slice(colonIndex + 1);
    // Component entries look like: Type "Name", Type "Name"
    const componentRegex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = componentRegex.exec(rest)) !== null) {
      const componentName = match[1].trim();
      if (componentName) names.components.push(componentName);
    }
  }

  private parseQueryLine(item: string, names: InventoryNames) {
    // "queryName on SourceName (operation)" or "queryName (operation)" or "queryName"
    const withoutParens = item.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const tokens = withoutParens.split(/\s+/);
    if (!tokens.length) return;

    const queryName = tokens[0];
    if (queryName && queryName.toLowerCase() !== 'none') {
      names.queries.push(queryName);
    }
  }

  private parseSourceLine(item: string, names: InventoryNames) {
    // "SourceName (kind), id xxx — tables: ..."
    const parenIndex = item.indexOf('(');
    const sourceName = parenIndex === -1 ? item : item.slice(0, parenIndex);
    if (sourceName.trim() && sourceName.trim().toLowerCase() !== 'none') {
      names.dataSources.push(sourceName.trim());
    }
  }

  private allNamesLowercased(names: InventoryNames): Set<string> {
    const all = [...names.pages, ...names.components, ...names.queries, ...names.dataSources];
    return new Set(all.map((name) => name.toLowerCase()).filter(Boolean));
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private textMentionsAnyName(normalizedText: string, names: Set<string>): boolean {
    for (const name of names) {
      const normalizedName = this.normalize(name);
      if (!normalizedName) continue;
      // Whole-word match: name is a token in the text.
      const regex = new RegExp(`\\b${this.escapeRegex(normalizedName)}\\b`, 'i');
      if (regex.test(normalizedText)) return true;
    }
    return false;
  }

  private hasBuildIntent(normalizedText: string): boolean {
    return BUILD_INTENT_KEYWORDS.some((keyword) => {
      const regex = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i');
      return regex.test(normalizedText);
    });
  }

  private extractExplicitEntityReferences(text: string): string[] {
    const candidates = new Set<string>();
    const entityKinds =
      'page|pages|component|components|widget|widgets|query|queries|table|tables|source|sources|form|forms|button|buttons|chart|charts';

    // "the Dashboard page", "on the Orders table", "this Customers form", etc.
    // Captures 1-3 consecutive capitalized words immediately before the entity kind.
    // (?-i:...) keeps the name itself case-sensitive while the surrounding match is
    // case-insensitive so "Page", "PAGE" and "page" all count as an entity kind.
    const explicitRegex = new RegExp(
      `(?:\\b(?:the|this|that|on|to|of|in|for)\\s+)?((?-i:[A-Z][a-zA-Z0-9]+(?:\\s+[A-Z][a-zA-Z0-9]+){0,2}))\\s+(?:${entityKinds})\\b`,
      'gi'
    );

    let match: RegExpExecArray | null;
    while ((match = explicitRegex.exec(text)) !== null) {
      const raw = match[1].trim();
      if (raw.length >= 2) candidates.add(raw);
    }

    return [...candidates];
  }

  private extractQuotedNames(text: string): string[] {
    const candidates = new Set<string>();
    const quoteRegex = /"([^"]{2,100})"/g;
    let match: RegExpExecArray | null;
    while ((match = quoteRegex.exec(text)) !== null) {
      candidates.add(match[1].trim());
    }
    return [...candidates];
  }

  private buildInfeasibleMessage(unknownNames: string[], names: InventoryNames): string {
    const quoted = unknownNames.map((name) => `"${name}"`).join(', ');
    const parts: string[] = [];
    if (names.pages.length) parts.push(`pages: ${names.pages.join(', ')}`);
    if (names.components.length) parts.push(`components: ${names.components.join(', ')}`);
    if (names.queries.length) parts.push(`queries: ${names.queries.join(', ')}`);
    if (names.dataSources.length) parts.push(`data sources: ${names.dataSources.join(', ')}`);

    const available = parts.length ? parts.join('; ') : 'nothing has been created in this app yet';

    return `I couldn't find ${quoted} in this app. Available ${available}. Please use existing names or describe a new app you want to build.`;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
