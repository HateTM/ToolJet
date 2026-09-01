// server/test/modules/ai/unit/event-update.helper.spec.ts
import { isKnownActionId, validateEventPatch, ACTION_IDS } from '@modules/ai/helpers/event-update.helper';

/** @group platform */
describe('isKnownActionId', () => {
  it('accepts the curated real action ids (copied from ActionTypes.js)', () => {
    expect(isKnownActionId('show-modal')).toBe(true);
    expect(isKnownActionId('run-query')).toBe(true);
  });

  it('rejects an invented action id', () => {
    expect(isKnownActionId('open-modal')).toBe(false); // the plausible-sounding hallucination
    expect(isKnownActionId('do-the-thing')).toBe(false);
  });
});

describe('validateEventPatch (ticket #67)', () => {
  const buttonEvents = ['onClick', 'onHover'];

  it('accepts a real eventId + a known actionId for the component type', () => {
    expect(
      validateEventPatch('Button', { eventId: 'onClick', actionId: 'show-modal', modal: 'comp-1' }, buttonEvents)
    ).toEqual({
      valid: true,
    });
  });

  it('rejects a hallucinated eventId not in the component type real event list — the "rowClick, not onRowClick" rule', () => {
    const result = validateEventPatch('Button', { eventId: 'onRowClick', actionId: 'show-modal' }, buttonEvents);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/onRowClick/);
  });

  it('rejects an eventId that is real for a different component type', () => {
    const result = validateEventPatch('Button', { eventId: 'onRowClicked', actionId: 'show-modal' }, buttonEvents);
    expect(result.valid).toBe(false);
  });

  it('rejects a missing eventId', () => {
    expect(validateEventPatch('Button', { actionId: 'show-modal' }, buttonEvents).valid).toBe(false);
  });

  it('rejects a missing or invented actionId', () => {
    expect(validateEventPatch('Button', { eventId: 'onClick' }, buttonEvents).valid).toBe(false);
    expect(validateEventPatch('Button', { eventId: 'onClick', actionId: 'delete-app' }, buttonEvents).valid).toBe(
      false
    );
  });

  it('every ACTION_IDS entry round-trips as known', () => {
    ACTION_IDS.forEach((id) => expect(isKnownActionId(id)).toBe(true));
  });
});
