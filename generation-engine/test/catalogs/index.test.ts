import { COMPONENT_CATALOG } from '../../src/catalogs/component-catalog';
import { EVENT_CATALOG } from '../../src/catalogs/event-catalog';
import { toPromptContext } from '../../src/catalogs';

describe('toPromptContext', () => {
  it('bundles both catalogs into one JSON-serializable object', () => {
    const ctx = toPromptContext();

    expect(ctx.components).toBe(COMPONENT_CATALOG);
    expect(ctx.eventActions).toBe(EVENT_CATALOG);
    expect(() => JSON.stringify(ctx)).not.toThrow();
  });
});
