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

  // Plan increment 3, Wave 1: componentsMeta.json entries ported from the EE meta snapshot
  // (TextArea/PasswordInput/NumberInput/Link/Divider/Icon/StarRating/Statistics/Tags/Datepicker,
  // see ADR-0026) or hand-authored for fork-only widgets (EmailInput/CurrencyInput/PhoneInput).
  // Each of AgentsService's Wave 1 builders sets exactly these properties — a dropped one here
  // would mean the widget renders with a property missing.
  describe('Wave 1 widget meta (plan increment 3)', () => {
    // Mirrors exactly what each AgentsService builder passes (agents.service.ts) — real
    // per-property types, not a placeholder string, so a type mismatch (e.g. StarRating's
    // maxRating expecting a number) is caught here rather than only at runtime.
    const wave1PropertyInputs: Record<string, Record<string, any>> = {
      TextArea: { label: { value: 'Label' }, placeholder: { value: '' }, value: { value: '' }, visibility: { value: '{{true}}' } },
      PasswordInput: { label: { value: 'Label' }, placeholder: { value: 'Password' }, value: { value: '' }, visibility: { value: '{{true}}' } },
      NumberInput: { label: { value: 'Label' }, placeholder: { value: '' }, value: { value: 0 }, visibility: { value: '{{true}}' } },
      EmailInput: { label: { value: 'Label' }, placeholder: { value: 'Enter email' }, value: { value: '' }, visibility: { value: '{{true}}' } },
      Link: {
        linkText: { value: 'Click here' },
        linkTarget: { value: 'https://dev.to/' },
        targetType: { value: 'new' },
        visibility: { value: '{{true}}' },
      },
      Divider: { label: { value: '' }, visibility: { value: '{{true}}' } },
      Icon: { icon: { value: 'IconHome2' }, visibility: { value: '{{true}}' } },
      StarRating: {
        label: { value: 'Select your rating' },
        maxRating: { value: '5' },
        defaultSelected: { value: '0' },
        visible: { value: '{{true}}' },
      },
      Statistics: {
        primaryValueLabel: { value: 'This months earnings' },
        primaryValue: { value: '682.3' },
        visibility: { value: '{{true}}' },
      },
      Tags: { data: { value: "{{ [ { title: 'success', color: '#34A94733', textColor: '#34A947' } ] }}" } },
      CurrencyInput: { label: { value: 'Label' }, placeholder: { value: 'Enter your number' }, value: { value: 0 }, visibility: { value: '{{true}}' } },
      PhoneInput: { label: { value: 'Label' }, placeholder: { value: 'Enter your input' }, value: { value: '' }, visibility: { value: '{{true}}' } },
    };

    it.each(Object.entries(wave1PropertyInputs))('%s: builder properties all pass sanitization', (type, input) => {
      const { result, warnings } = sanitizeComponentSection(type, 'properties', input);

      expect(Object.keys(result)).toEqual(Object.keys(input));
      expect(warnings).toHaveLength(0);
    });

    it('Datepicker: properties set by the builder pass sanitization', () => {
      const { result, warnings } = sanitizeComponentSection('Datepicker', 'properties', {
        defaultValue: { value: '01/01/2022' },
        placeholder: { value: 'Select date' },
        format: { value: 'DD/MM/YYYY' },
      });

      expect(Object.keys(result)).toEqual(['defaultValue', 'placeholder', 'format']);
      expect(warnings).toHaveLength(0);
    });

    it('Datepicker: visibility lives under styles, not properties (legacy widget quirk)', () => {
      const { result, warnings } = sanitizeComponentSection('Datepicker', 'styles', {
        visibility: { value: '{{true}}' },
      });

      expect(result).toEqual({ visibility: { value: '{{true}}' } });
      expect(warnings).toHaveLength(0);
    });
  });

  // Plan increment 3, Wave 2: componentsMeta.json entries for Tabs/Listview/IFrame/
  // FilePicker/ModalV2/TreeSelect/Html ported from the EE meta snapshot; PopoverMenu/
  // ButtonGroupV2/DatePickerV2/Chat (no EE equivalent) hand-authored from this fork's own
  // widget configs. Same rationale as Wave 1 (ADR-0026): a dropped property here means the
  // widget renders with it missing.
  describe('Wave 2 widget meta (plan increment 3)', () => {
    const wave2PropertyInputs: Record<string, Record<string, any>> = {
      Tabs: {
        tabs: { value: "{{[ { title: 'Home', id: '0' } ]}}" },
        defaultTab: { value: '0' },
        visibility: { value: '{{true}}' },
      },
      Listview: { mode: { value: 'list' }, visible: { value: '{{true}}' } },
      IFrame: { source: { value: 'https://tooljet.com' }, visible: { value: '{{true}}' } },
      FilePicker: { label: { value: 'Upload files' }, visibility: { value: '{{true}}' } },
      ModalV2: {
        useDefaultButton: { value: '{{true}}' },
        triggerButtonLabel: { value: 'Launch Modal' },
        visibility: { value: '{{true}}' },
      },
      TreeSelect: { label: { value: 'Options' } },
      Html: { rawHtml: { value: '<div>Hello world</div>' } },
      PopoverMenu: {
        label: { value: 'Menu' },
        options: {
          value: [
            {
              format: 'plain',
              label: 'option1',
              description: '',
              value: '1',
              icon: { value: 'IconBolt' },
              iconVisibility: false,
              disable: { value: false },
              visible: { value: true },
            },
          ],
        },
        visibility: { value: '{{true}}' },
      },
      ButtonGroupV2: {
        label: { value: 'Label' },
        options: {
          value: [
            { label: 'Button1', value: '1', icon: { value: 'IconBolt' }, iconVisibility: false, disable: { value: false }, default: { value: true } },
          ],
        },
        visibility: { value: '{{true}}' },
      },
      DatePickerV2: {
        label: { value: 'Label' },
        defaultValue: { value: '01/01/2022' },
        placeholder: { value: 'Select date' },
        dateFormat: { value: 'DD/MM/YYYY' },
        visibility: { value: '{{true}}' },
      },
      Chat: { chatTitle: { value: 'Chat' }, visibility: { value: '{{true}}' } },
    };

    it.each(Object.entries(wave2PropertyInputs))('%s: builder properties all pass sanitization', (type, input) => {
      const { result, warnings } = sanitizeComponentSection(type, 'properties', input);

      expect(Object.keys(result)).toEqual(Object.keys(input));
      expect(warnings).toHaveLength(0);
    });
  });
});
