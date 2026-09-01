import {
  normalizeEventId,
  validateEventBody,
  renderEventCatalogForPrompt,
} from '../../../../src/modules/ai/services/event-catalog';

describe('event-catalog (ticket #67: machine catalog of valid events)', () => {
  describe('normalizeEventId', () => {
    it('maps the loose event names from a design to the platform real event ids', () => {
      expect(normalizeEventId('rowClick')).toBe('onRowClicked');
      expect(normalizeEventId('onrowclicked')).toBe('onRowClicked');
      expect(normalizeEventId('click')).toBe('onClick');
      expect(normalizeEventId('submit')).toBe('onSubmit');
    });

    it('passes an exact event id through unchanged', () => {
      expect(normalizeEventId('onRowClicked')).toBe('onRowClicked');
      expect(normalizeEventId('onCellValueChanged')).toBe('onCellValueChanged');
    });
  });

  describe('validateEventBody', () => {
    it('accepts a valid component event and returns the normalized eventId', () => {
      const body = validateEventBody(
        { eventId: 'click', actionId: 'show-modal', modal: 'detailsModal' },
        'component',
        'Button'
      );
      expect(body).toEqual({
        eventId: 'onClick',
        actionId: 'show-modal',
        modal: 'detailsModal',
      });
    });

    it('rejects an unknown actionId with the valid ones listed', () => {
      expect(() =>
        validateEventBody({ eventId: 'onClick', actionId: 'delete-everything' }, 'component', 'Button')
      ).toThrow(/delete-everything/);
      expect(() =>
        validateEventBody({ eventId: 'onClick', actionId: 'delete-everything' }, 'component', 'Button')
      ).toThrow(/run-query/);
    });

    it('rejects an eventId that is not valid for the target component type', () => {
      expect(() =>
        validateEventBody({ eventId: 'onRowClicked', actionId: 'show-alert', message: 'hi' }, 'component', 'Button')
      ).toThrow(/Button/);
      expect(() =>
        validateEventBody(
          { eventId: 'onDataQuerySuccess', actionId: 'show-alert', message: 'hi' },
          'component',
          'Button'
        )
      ).toThrow(/Button/);
    });

    it('accepts a data-query event only against a data query', () => {
      expect(() =>
        validateEventBody(
          { eventId: 'onDataQuerySuccess', actionId: 'show-alert', message: 'done' },
          'component',
          'Table'
        )
      ).toThrow();
      const body = validateEventBody(
        { eventId: 'onDataQueryFailure', actionId: 'show-alert', message: 'failed' },
        'data_query'
      );
      expect(body.eventId).toBe('onDataQueryFailure');
    });

    it('rejects keys the action does not allow (no invented keys)', () => {
      expect(() =>
        validateEventBody(
          { eventId: 'onClick', actionId: 'show-modal', modal: 'm', queryId: 'q1' },
          'component',
          'Button'
        )
      ).toThrow(/queryId/);
    });

    it('rejects undefined values and non-object bodies', () => {
      expect(() =>
        validateEventBody({ eventId: 'onClick', actionId: 'show-alert', message: undefined }, 'component', 'Button')
      ).toThrow(/undefined/);
      expect(() => validateEventBody(null, 'component', 'Button')).toThrow();
      expect(() => validateEventBody([1, 2], 'component', 'Button')).toThrow();
    });

    it('requires componentSpecificActionParams to be an array for control-component', () => {
      expect(() =>
        validateEventBody(
          {
            eventId: 'onClick',
            actionId: 'control-component',
            componentId: 'c1',
            componentSpecificActionHandle: 'open',
          },
          'component',
          'Button'
        )
      ).toThrow(/componentSpecificActionParams/);
      const body = validateEventBody(
        {
          eventId: 'onClick',
          actionId: 'control-component',
          componentId: 'c1',
          componentSpecificActionHandle: 'open',
          componentSpecificActionParams: [],
        },
        'component',
        'Button'
      );
      expect(body.componentSpecificActionParams).toEqual([]);
    });
  });

  describe('renderEventCatalogForPrompt', () => {
    it('renders the machine list the prompt is grounded in', () => {
      const catalog = renderEventCatalogForPrompt();
      expect(catalog).toContain('run-query (keys: queryId)');
      expect(catalog).toContain('onRowClicked');
      expect(catalog).toContain('data query: onDataQuerySuccess, onDataQueryFailure');
    });
  });
});
