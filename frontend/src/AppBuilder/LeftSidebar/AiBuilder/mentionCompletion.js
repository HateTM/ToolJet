import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { filterMentionOptions } from './mentionCatalog';

/**
 * The @-mention autocomplete source (ticket #27): typing `@` (optionally followed by
 * characters) opens a completion list of the app's pages/components/queries. Accepting an
 * option inserts `@name ` as display text and reports the resolvable reference back through
 * `onMentionSelect` — the display text is what the user and the LLM see in the message, the
 * reference (a real id snapshot) is what rides the message payload to the backend.
 *
 * `getCatalog`/`onMentionSelect` are read per-keystroke (via getters) so the extension can
 * keep a stable identity across renders while the catalog and handlers stay current.
 *
 * @param {Object} params
 * @param {() => import('./mentionCatalog').MentionCatalog} params.getCatalog
 * @param {(reference: object) => void} params.onMentionSelect
 * @returns {import('@codemirror/state').Extension}
 */
export const mentionCompletion = ({ getCatalog, onMentionSelect }) =>
  autocompletion({
    override: [
      (context) => {
        // The mention trigger is an `@` at a word start, up to the cursor. Require a word
        // boundary before `@` so emails (user@example.com) don't open the list.
        const before = context.matchBefore(/(?:^|\s)@([\w.-]*)$/);
        if (!before) return null;

        const term = before.text.slice(before.text.indexOf('@') + 1);
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
          from: before.from + before.text.indexOf('@'),
          options,
          validFor: /^@?[\w.-]*$/,
        };
      },
    ],
  });

export default mentionCompletion;
