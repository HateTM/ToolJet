// server/test/modules/ai/unit/component-schema.spec.ts
import { sanitizeComponentSection } from '@modules/ai/helpers/component-type-validator';
import { normalizeMalformedOptionsProperty } from '@modules/ai/helpers/component-options.utils';
import { getDefaultValue } from '@modules/ai/helpers/widget-meta';

/** @group platform */
describe('component schema validation (ticket #60)', () => {
  describe('sanitizeComponentSection', () => {
    it('drops a hallucinated property with a warning instead of saving it', () => {
      const { result, warnings } = sanitizeComponentSection('Button', 'properties', {
        text: { value: 'Save' },
        colorScheme: { value: 'rainbow' }, // not a Button property in componentsMeta
      });

      expect(result).toEqual({ text: { value: 'Save' } });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Button.properties.colorScheme');
      expect(warnings[0]).toContain('unknown property dropped');
    });

    it('replaces an invalid static value of a known property with the widget default', () => {
      // Button.text expects a string (validation schema from frontend widget meta)
      const { result, warnings } = sanitizeComponentSection('Button', 'properties', {
        text: { value: 12345 },
      });

      expect(result.text.value).toEqual(getDefaultValue('Button', 'properties', 'text'));
      expect(warnings[0]).toContain('invalid value');
      expect(warnings[0]).toContain('using default');
    });

    it('passes {{...}} template expressions through unvalidated', () => {
      const { result, warnings } = sanitizeComponentSection('Button', 'properties', {
        text: { value: '{{components.TextInput1.value}}' },
        visibility: { value: '{{false}}' },
      });

      expect(result.text.value).toBe('{{components.TextInput1.value}}');
      expect(result.visibility.value).toBe('{{false}}');
      expect(warnings).toHaveLength(0);
    });

    it('keeps valid values untouched and produces no warnings', () => {
      const { result, warnings } = sanitizeComponentSection('Button', 'properties', {
        text: { value: 'Save' },
        disabledState: { value: false },
      });

      expect(result).toEqual({ text: { value: 'Save' }, disabledState: { value: false } });
      expect(warnings).toHaveLength(0);
    });

    it('sanitizes the styles section against the same meta', () => {
      const { result, warnings } = sanitizeComponentSection('Button', 'styles', {
        textShadowBlur: { value: '4px' }, // hallucinated style
      });

      expect(result).toEqual({});
      expect(warnings[0]).toContain('Button.styles.textShadowBlur');
    });
  });

  describe('integration of the two passes (ticket #60 review fixes)', () => {
    it('lets string-form options survive sanitization and get normalized', () => {
      // Simulates the agents.service order: normalize first, then sanitize.
      const properties = { options: { value: '[{"label": "Open", "value": "open"}]' } };
      normalizeMalformedOptionsProperty('DropdownV2', properties);
      const { result } = sanitizeComponentSection('DropdownV2', 'properties', properties);

      expect(result.options.value).toEqual([expect.objectContaining({ label: 'Open', value: 'open' })]);
    });

    it('does not replace a static value on a property whose default is a template', () => {
      // Modal.hideOnEsc defaults to '{{true}}' — a static boolean must pass as-is,
      // not be "corrected" into the template (which would invert the semantics).
      const { result, warnings } = sanitizeComponentSection('Modal', 'properties', {
        hideOnEsc: { value: false },
      });

      expect(result.hideOnEsc.value).toBe(false);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('normalizeMalformedOptionsProperty', () => {
    it('maps a plain string array onto the option-list shape', () => {
      const properties = { options: { value: ['Open', 'Closed'] } };
      const { warnings } = normalizeMalformedOptionsProperty('DropdownV2', properties);

      expect(properties.options.value).toEqual([
        expect.objectContaining({ label: 'Open', value: 'Open' }),
        expect.objectContaining({ label: 'Closed', value: 'Closed' }),
      ]);
      expect(warnings).toHaveLength(0);
    });

    it('reconstructs a char-object array (each entry { "0": chunk }) into a real option list', () => {
      const properties = {
        options: {
          value: [{ '0': '[{"label": "Open"' }, { '0': ', "value": "open"}]' }] as any,
        },
      };
      const { warnings } = normalizeMalformedOptionsProperty('DropdownV2', properties);

      expect(properties.options.value).toEqual([
        {
          label: 'Open',
          value: 'open',
          caption: null,
          disable: { value: false },
          visible: { value: true },
          default: { value: false },
        },
      ]);
      expect(warnings.join(' ')).toContain('char-object array reconstructed');
    });

    it('repairs a malformed options string (single-quoted JSON) into widget option objects', () => {
      const properties = {
        options: { value: `"[{label: 'Low', value: 'low'}, {label: 'High', value: 'high'}]"` },
      };
      normalizeMalformedOptionsProperty('DropdownV2', properties);

      expect(properties.options.value).toEqual([
        expect.objectContaining({ label: 'Low', value: 'low' }),
        expect.objectContaining({ label: 'High', value: 'high' }),
      ]);
    });

    it('accepts plain string options { label, name, title } aliases and maps id → value', () => {
      const properties = {
        options: {
          value: [
            { name: 'Pending' },
            { title: 'Done', id: 42 },
            { label: 'Blocked', value: 'blocked', disable: true },
          ],
        },
      };
      normalizeMalformedOptionsProperty('DropdownV2', properties);

      expect(properties.options.value).toEqual([
        {
          label: 'Pending',
          value: 'Pending',
          caption: null,
          disable: { value: false },
          visible: { value: true },
          default: { value: false },
        },
        {
          label: 'Done',
          value: '42',
          caption: null,
          disable: { value: false },
          visible: { value: true },
          default: { value: false },
        },
        {
          label: 'Blocked',
          value: 'blocked',
          caption: null,
          disable: { value: true },
          visible: { value: true },
          default: { value: false },
        },
      ]);
    });

    it('keeps a {{...}} template binding for runtime resolution', () => {
      const properties = {
        options: { value: '{{queries.statuses.data}}' },
      };
      const { warnings } = normalizeMalformedOptionsProperty('DropdownV2', properties);

      expect(properties.options.value).toBe('{{queries.statuses.data}}');
      expect(warnings).toHaveLength(0);
    });

    it('falls back to the widget default options when the value is unrecoverable', () => {
      const properties = {
        options: { value: 'this is not options at all' },
      };
      const { warnings } = normalizeMalformedOptionsProperty('DropdownV2', properties);
      const widgetDefault = getDefaultValue('DropdownV2', 'properties', 'options');

      expect(properties.options.value).toEqual(widgetDefault);
      expect(warnings.join(' ')).toContain('widget defaults');
    });

    it('falls back to an empty list for a widget without default options', () => {
      const properties = {
        options: { value: { broken: true } } as any,
      };
      normalizeMalformedOptionsProperty('Button', properties);

      expect(properties.options.value).toEqual([]);
    });

    it('normalizes entries of an already-array value (label/name aliases, boolean flags)', () => {
      const properties = {
        options: { value: [{ label: 'A' }, { value: 'b', visible: false }] },
      };
      const { warnings } = normalizeMalformedOptionsProperty('DropdownV2', properties);

      expect(properties.options.value).toEqual([
        {
          label: 'A',
          value: 'A',
          caption: null,
          disable: { value: false },
          visible: { value: true },
          default: { value: false },
        },
        {
          label: '',
          value: 'b',
          caption: null,
          disable: { value: false },
          visible: { value: false },
          default: { value: false },
        },
      ]);
      expect(warnings).toHaveLength(0);
    });
  });
});
