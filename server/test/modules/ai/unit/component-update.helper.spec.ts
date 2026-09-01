// server/test/modules/ai/unit/component-update.helper.spec.ts
import { isEmptyPatch, wrapPatchSection, snapshotPreviousSection } from '@modules/ai/helpers/component-update.helper';

/** @group platform */
describe('isEmptyPatch (ticket #66)', () => {
  it('is true for undefined/null', () => {
    expect(isEmptyPatch(undefined)).toBe(true);
    expect(isEmptyPatch(null as any)).toBe(true);
  });

  it('is true for {} and for a patch with only empty sections — the "no changes" outcome the LLM contract requires', () => {
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ properties: {}, styles: {} })).toBe(true);
  });

  it('is false once either section carries a key', () => {
    expect(isEmptyPatch({ properties: { text: 'New title' } })).toBe(false);
    expect(isEmptyPatch({ styles: { color: 'red' } })).toBe(false);
  });

  it('is false for an event-only patch (ticket #67) — it must not be dropped as a no-op', () => {
    expect(isEmptyPatch({ event: { eventId: 'onClick', actionId: 'show-modal', modal: 'comp-1' } })).toBe(false);
  });
});

describe('wrapPatchSection', () => {
  it('wraps flat values into the { value } shape sanitizeComponentSection expects', () => {
    expect(wrapPatchSection({ text: 'New title', visible: true })).toEqual({
      text: { value: 'New title' },
      visible: { value: true },
    });
  });

  it('returns undefined for an absent section, not an empty object', () => {
    expect(wrapPatchSection(undefined)).toBeUndefined();
  });
});

describe('snapshotPreviousSection (compensating undo, ticket #66)', () => {
  const current = {
    text: { value: 'Old title' },
    visible: { value: true },
    loadingState: { value: false },
  };

  it('captures only the keys the patch touches — siblings are never disturbed', () => {
    const snapshot = snapshotPreviousSection(current, { text: 'New title' });
    expect(snapshot).toEqual({ text: { value: 'Old title' } });
    // The sanity check the diff-merge AC is really about: properties this step never
    // mentioned (visible, loadingState) don't appear in the undo snapshot at all, so
    // restoring it can't clobber them.
    expect(snapshot).not.toHaveProperty('visible');
    expect(snapshot).not.toHaveProperty('loadingState');
  });

  it('omits a key the component had no prior value for (documented undo limitation)', () => {
    const snapshot = snapshotPreviousSection(current, { brandNewProp: 'x' });
    expect(snapshot).toEqual({});
  });

  it('returns {} when the patch section is absent', () => {
    expect(snapshotPreviousSection(current, undefined)).toEqual({});
  });
});
