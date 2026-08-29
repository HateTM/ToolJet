import { autocompletion } from '@codemirror/autocomplete';
import { filterMentionOptions } from './mentionCatalog';

/**
 * The @-mention completion source (ticket #27): typing `@` (optionally followed by
 * characters) at a word start offers the app's pages/components/queries. Accepting an
 * option inserts `@name ` as display text and reports the resolvable reference back
 * through `onMentionSelect` — the display text is what the user and the LLM see in the
 * message, the reference (a real id snapshot) is what rides the message payload to the
 * backend.
 *
 * `getCatalog`/`onMentionSelect` are read per invocation (via getters) so the extension
 * can keep a stable identity across renders while the catalog and handlers stay current.
 * Exported separately from the autocompletion() wrapper so it can be driven directly in
 * unit tests.
 *
 * @param {Object} params
 * @param {() => object} params.getCatalog
 * @param {(reference: object) => void} [params.onMentionSelect]
 * @returns {(context: import('@codemirror/autocomplete').CompletionContext) => Promise<any>}
 */
export const mentionCompletionSource =
  ({ getCatalog, onMentionSelect }) =>
  async (context) => {
    // The mention trigger is an `@` at a word start, up to the cursor. Require a word
    // boundary before `@` so emails (user@example.com) don't open the list.
    const before = context.matchBefore(/(?:^|\s)@([\w.-]*)$/);
    if (!before) return null;

    const atSignPosition = before.text.indexOf('@');
    const term = before.text.slice(atSignPosition + 1);
    const options = filterMentionOptions(getCatalog(), term).map((option) => ({
      label: option.label,
      detail: option.detail,
      type: option.type,
      apply: (view, _completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: `@${option.label} ` },
          selection: { anchor: from + option.label.length + 2 },
        });
        onMentionSelect?.(option.reference);
      },
    }));
    if (!options.length) return null;

    return {
      from: before.from + atSignPosition,
      options,
      validFor: /^@?[\w.-]*$/,
    };
  };

/**
 * The autocompletion() extension for PromptEditor's `extensions` prop.
 */
export const mentionCompletion = ({ getCatalog, onMentionSelect }) =>
  autocompletion({
    override: [mentionCompletionSource({ getCatalog, onMentionSelect })],
  });

export default mentionCompletion;
