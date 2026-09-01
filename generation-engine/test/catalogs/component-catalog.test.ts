import { COMPONENT_CATALOG } from '../../src/catalogs/component-catalog';
import { getComponent, getComponentTriggers, isValidTrigger, listComponentNames } from '../../src/catalogs';

// The fork's server/src/modules/ai/helpers/componentsMeta.json covers exactly this set (11
// widgets) -- AC #92 requires at least this coverage.
const FORK_COMPONENT_SET = [
  'Table',
  'Button',
  'Text',
  'TextInput',
  'Container',
  'Form',
  'Chart',
  'Image',
  'Checkbox',
  'DropdownV2',
  'Modal',
];

describe('component catalog', () => {
  it('covers at least the fork componentsMeta.json component set', () => {
    for (const name of FORK_COMPONENT_SET) {
      expect(COMPONENT_CATALOG[name]).toBeDefined();
    }
  });

  it('lists every catalog component name via listComponentNames()', () => {
    expect(listComponentNames().sort()).toEqual(Object.keys(COMPONENT_CATALOG).sort());
  });

  it('gives every entry a name, category, properties array and triggers array', () => {
    for (const [key, entry] of Object.entries(COMPONENT_CATALOG)) {
      expect(entry.name).toBe(key);
      expect(['data', 'input', 'display', 'layout']).toContain(entry.category);
      expect(Array.isArray(entry.properties)).toBe(true);
      expect(entry.properties.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.triggers)).toBe(true);
    }
  });

  it('gives every property a name and a valueType', () => {
    for (const entry of Object.values(COMPONENT_CATALOG)) {
      for (const prop of entry.properties) {
        expect(typeof prop.name).toBe('string');
        expect(prop.name.length).toBeGreaterThan(0);
        expect(['string', 'number', 'boolean', 'array', 'object', 'dynamic']).toContain(prop.valueType);
      }
    }
  });

  it('does not carry forward componentsMeta.json demo/seed defaults', () => {
    // Table.data and Form.JSONData carried multi-row fake-person / nested demo objects in the
    // fork's componentsMeta.json (ADR-0033: not migrated). Confirm they were dropped, not copied.
    const tableData = COMPONENT_CATALOG.Table.properties.find((p) => p.name === 'data');
    const formData = COMPONENT_CATALOG.Form.properties.find((p) => p.name === 'JSONData');
    expect(tableData?.defaultValue).toBeUndefined();
    expect(formData?.defaultValue).toBeUndefined();
  });

  it('getComponent looks up a known component and returns undefined for an unknown one', () => {
    expect(getComponent('Table')).toBe(COMPONENT_CATALOG.Table);
    expect(getComponent('NotAWidget')).toBeUndefined();
  });

  describe('triggers (per-component event vocabulary)', () => {
    it('getComponentTriggers returns the component-scoped trigger list', () => {
      const triggers = getComponentTriggers('Table');
      expect(triggers?.map((t) => t.id)).toContain('onRowClicked');
    });

    it('getComponentTriggers returns undefined for an unknown component', () => {
      expect(getComponentTriggers('NotAWidget')).toBeUndefined();
    });

    it('isValidTrigger is true only for triggers the component actually raises', () => {
      expect(isValidTrigger('Table', 'onRowClicked')).toBe(true);
      expect(isValidTrigger('Table', 'onSubmit')).toBe(false); // Form's trigger, not Table's
      expect(isValidTrigger('NotAWidget', 'onClick')).toBe(false);
    });

    it("Form exposes onSubmit, matching agents.service.ts's current hardcoded event", () => {
      expect(isValidTrigger('Form', 'onSubmit')).toBe(true);
    });

    it('Container (no events in the widget config) has an empty trigger list, not undefined', () => {
      expect(COMPONENT_CATALOG.Container.triggers).toEqual([]);
    });
  });
});
