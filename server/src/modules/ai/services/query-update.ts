import { tool } from 'ai';
import { z } from 'zod';
import { isSingleReadOnlyStatement } from './query-security';
import { updateQuery as updateQueryPrompts } from '../prompt-library';

/**
 * Ticket #67, prompt sourced from the ported EE library (prompt-library/updateQuery.ts):
 * the model returns ONLY the option paths that changed, and the merge below applies them
 * onto the existing options without touching anything else. Unlike EE, the query's name
 * and data source can never change — those are the read-only parts of the contract here,
 * so the tool schema doesn't even accept them.
 */
export const UPDATE_QUERY_SYSTEM_PROMPT = [
  updateQueryPrompts.systemPrompt(),
  `Call updateQuery exactly once. You are shown the query's current options and the list of other queries in the app; pick the target by its exact name.

Rules:
- Return ONLY the option keys that actually change, with their new values. Everything you omit is left exactly as it is — never return unchanged keys, and never return the whole options object.
- Never change the query's name or its data source. They are not part of the response.
- When the query runs against a connected SQL source (mode "sql"), the updated statement must remain a single read-only SELECT.
- Keep expression syntax consistent with the rest of the options: bindings use {{ components.name.property }} / {{ queries.name.data }}.`,
].join('\n\n');

export const updateQueryTool = tool({
  description: 'Update one existing data query by returning only the options that changed.',
  parameters: z.object({
    queryName: z.string().describe('Exact name of the existing query to update'),
    options: z
      .record(z.any())
      .describe('Only the option keys that change, with their new values — everything omitted stays as-is'),
  }),
});

/**
 * Merges the LLM's changed-options patch onto the query's existing options. The merge is
 * per top-level option key (EE's "maintain the exact nesting structure" contract): a key
 * the patch names is replaced wholesale, every other key — validation rules, parameters,
 * transformations the PRD never mentioned — survives untouched.
 */
export const mergeQueryUpdate = (
  existingOptions: Record<string, any>,
  patchOptions: Record<string, any>
): Record<string, any> => {
  if (!existingOptions || typeof existingOptions !== 'object' || Array.isArray(existingOptions)) {
    throw new Error('The query being updated has no existing options to merge onto');
  }
  if (!patchOptions || typeof patchOptions !== 'object' || Array.isArray(patchOptions)) {
    throw new Error('The query update must be an object of option keys to new values');
  }
  if (Object.keys(patchOptions).length === 0) {
    throw new Error('The query update changed no options');
  }
  return { ...(existingOptions ?? {}), ...patchOptions };
};

/**
 * The security gate an updated query must pass before it is persisted (ticket #5's
 * acceptance criteria: "проходит существующие security-валидации"). A merged patch could
 * otherwise walk a stored read-only SQL query into a write one — the same bar
 * buildExternalQueryProps enforces on the CREATE path, applied to the merged result.
 */
export const validateMergedQueryOptions = (mergedOptions: Record<string, any>): Record<string, any> => {
  if (mergedOptions?.mode === 'sql' && !isSingleReadOnlyStatement(mergedOptions.query)) {
    throw new Error('The updated SQL query must be a single read-only SELECT statement');
  }
  return mergedOptions;
};
