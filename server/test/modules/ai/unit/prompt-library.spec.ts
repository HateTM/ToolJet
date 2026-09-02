import * as promptLibrary from '../../../../src/modules/ai/prompt-library';

/**
 * Smoke test for the ported EE prompt library (plan increment 2): every namespace exported
 * from index.ts must resolve and expose at least one prompt function that returns a
 * non-empty string. Guards against a broken or half-copied port — the library is data,
 * so there is no behavior beyond "it imports and produces prompt text".
 */
describe('prompt-library (ported EE prompts)', () => {
  const NAMESPACES = Object.entries(promptLibrary);

  it('exports the expected namespaces', () => {
    expect(Object.keys(promptLibrary).sort()).toEqual(
      [
        'applicationNameSimilarityCheck',
        'componentsAgent',
        'describeAppClassifier',
        'evaluatePrompt',
        'featureAnalysis',
        'featurePlanner',
        'fixWithAi',
        'generateComponent',
        'generateDummyData',
        'generateEvent',
        'generateLayout',
        'generateLLDPrompt',
        'generatePrd',
        'generateQuery',
        'generateTablesPrompt',
        'generateTodoList',
        'generateTJDBQuery',
        'generateTJDBTables',
        'siblingLayoutOptimise',
        'updateComponent',
        'updateEvent',
        'updateQuery',
      ].sort()
    );
  });

  it.each(NAMESPACES.map(([name]) => name))('%s exposes at least one string prompt', (name) => {
    const namespace = promptLibrary[name] as Record<string, unknown>;
    const promptFns = Object.values(namespace).filter(
      (value): value is (...args: never[]) => string => typeof value === 'function'
    );
    expect(promptFns.length).toBeGreaterThan(0);
    const first = promptFns[0] as (...args: unknown[]) => string;
    // First arg is only JSON.stringify-ed or interpolated by the prompts, so any
    // placeholder object keeps every prompt on its code path.
    expect(typeof first({})).toBe('string');
    expect(first({}).length).toBeGreaterThan(0);
  });
});
