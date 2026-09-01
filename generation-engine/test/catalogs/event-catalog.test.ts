import { EVENT_CATALOG } from '../../src/catalogs/event-catalog';
import { getEventAction, isValidEventAction, listEventActionIds } from '../../src/catalogs';

describe('event catalog', () => {
  it('is keyed by the same kebab-case id every entry declares', () => {
    for (const [key, entry] of Object.entries(EVENT_CATALOG)) {
      expect(entry.id).toBe(key);
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('enumerates real platform action ids, not fork-invented ones', () => {
    // 'run-query' is the one action the fork actually emits today (agents.service.ts's hardcoded
    // Submit-form event). The others come from the platform's own event editor
    // (ActionTypes.js) -- this is not a fabricated list.
    expect(EVENT_CATALOG['run-query']).toBeDefined();
    expect(EVENT_CATALOG['show-alert']).toBeDefined();
    expect(EVENT_CATALOG['open-webpage']).toBeDefined();
    expect(EVENT_CATALOG['go-to-app']).toBeDefined();
    expect(EVENT_CATALOG['show-modal']).toBeDefined();
  });

  it('does not key on the unrelated camelCase ACTIONS code-hint vocabulary', () => {
    // frontend/src/AppBuilder/_stores/constants/actions.js has 'runQuery', 'showAlert', etc --
    // a different id space for the code-hint list, not what event_handler persists.
    expect(EVENT_CATALOG['runQuery']).toBeUndefined();
    expect(EVENT_CATALOG['showAlert']).toBeUndefined();
  });

  it('gives every action a name, group and an options array (possibly empty)', () => {
    for (const entry of Object.values(EVENT_CATALOG)) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.group).toBe('string');
      expect(Array.isArray(entry.options)).toBe(true);
    }
  });

  it('gives every option a name and a text/code type', () => {
    for (const entry of Object.values(EVENT_CATALOG)) {
      for (const opt of entry.options) {
        expect(typeof opt.name).toBe('string');
        expect(['text', 'code']).toContain(opt.type);
      }
    }
  });

  it('listEventActionIds lists every catalog key', () => {
    expect(listEventActionIds().sort()).toEqual(Object.keys(EVENT_CATALOG).sort());
  });

  it('getEventAction looks up a known action and returns undefined for an unknown one', () => {
    expect(getEventAction('run-query')).toBe(EVENT_CATALOG['run-query']);
    expect(getEventAction('not-a-real-action')).toBeUndefined();
  });

  it('isValidEventAction matches getEventAction', () => {
    expect(isValidEventAction('run-query')).toBe(true);
    expect(isValidEventAction('not-a-real-action')).toBe(false);
  });
});
