// server/test/modules/ai/unit/generate-layout.spec.ts
import { compactRootLayouts, generateComponentLayout, SiblingRect } from '@modules/ai/helpers/layout/generate-layout';
import { GRID, SIBLING_GAP, TABS_FIXED_LAYOUT } from '@modules/ai/helpers/layout/layout.constants';

/** @group platform */
describe('generateComponentLayout (ticket #63)', () => {
  const rect = (overrides: Partial<SiblingRect>): SiblingRect => ({
    id: 'id-1',
    type: 'Button',
    left: 1,
    top: 5,
    width: 4,
    height: 40,
    ...overrides,
  });

  describe('grid rules', () => {
    it('places the first component on an empty page at the grid top', () => {
      const { layout, siblingUpdates } = generateComponentLayout('Button', []);
      expect(layout).toEqual({ left: 1, top: GRID.TOP_MIN, width: 4, height: 40 });
      expect(siblingUpdates).toBeNull();
    });

    it('always keeps left + width <= 42 and width <= 40', () => {
      const { layout } = generateComponentLayout('Button', [], { width: 99, height: 100 });
      expect(layout.width).toBe(GRID.WIDTH_MAX);
      expect(layout.left + layout.width).toBeLessThanOrEqual(GRID.MAX_RIGHT);
    });
    it('caps height so the component still fits under the grid bottom', () => {
      const { layout } = generateComponentLayout('Container', [], { width: 10, height: 99999 });
      expect(layout.top + layout.height).toBeLessThanOrEqual(GRID.MAX_BOTTOM);
    });

    it('coerces non-finite desired sizes into grid-valid ones', () => {
      const { layout } = generateComponentLayout('Button', [], { width: NaN, height: NaN });
      expect(layout.width).toBeGreaterThanOrEqual(1);
      expect(layout.height).toBeGreaterThanOrEqual(1);
      expect(layout.left + layout.width).toBeLessThanOrEqual(GRID.MAX_RIGHT);
    });

    it('uses the widget default size when no desired size is given', () => {
      const { layout } = generateComponentLayout('TextInput', []);
      expect(layout).toMatchObject({ width: 10, height: 40 });
    });

    it('falls back to a generic size for unknown widget types', () => {
      const { layout } = generateComponentLayout('MysteryWidget', []);
      expect(layout.left + layout.width).toBeLessThanOrEqual(GRID.MAX_RIGHT);
      expect(layout.top + layout.height).toBeLessThanOrEqual(GRID.MAX_BOTTOM);
    });
  });

  describe('anti-overlap (siblings)', () => {
    it('places the next component below the existing one with the required gap', () => {
      const sibling = rect({ top: 5, height: 40 }); // bottom = 45
      const { layout, siblingUpdates } = generateComponentLayout('Button', [sibling]);
      expect(layout.top).toBe(45 + SIBLING_GAP);
      expect(siblingUpdates).toBeNull();
    });

    it('fills the first free vertical slot between two siblings', () => {
      const top = rect({ id: 'a', top: 5, height: 40 }); // bottom 45
      const bottom = rect({ id: 'b', top: 200, height: 40 });
      const { layout } = generateComponentLayout('Text', [top, bottom], { width: 6, height: 100 });
      // slot between (45+gap .. 200) is 145 units tall — fits 100 with gaps
      expect(layout.top).toBe(45 + SIBLING_GAP);
      expect(layout.top + layout.height + SIBLING_GAP).toBeLessThanOrEqual(200);
    });

    it('ignores siblings placed lower than the grid bottom allows', () => {
      // A sibling whose slot candidates fall outside the grid cannot trap placement
      const low = rect({ id: 'low', top: 980, height: 10 });
      const { layout } = generateComponentLayout('Button', [low]);
      expect(layout.top + layout.height).toBeLessThanOrEqual(GRID.MAX_BOTTOM);
      expect(layout.top).toBeLessThan(low.top);
    });
  });

  describe('Tabs fixed layout', () => {
    it('uses the fixed full-page layout for Tabs', () => {
      const { layout, siblingUpdates } = generateComponentLayout('Tabs', []);
      expect(layout).toEqual(TABS_FIXED_LAYOUT);
      expect(siblingUpdates).toBeNull();
    });

    it('throws when a Tabs already exists on the page', () => {
      const tabs = rect({ id: 'tabs-1', type: 'Tabs', ...TABS_FIXED_LAYOUT });
      expect(() => generateComponentLayout('Tabs', [tabs])).toThrow(/only one Tabs per page/);
    });
  });

  describe('compaction fallback', () => {
    it('compacts siblings and reports their recomputed tops when no free slot fits', () => {
      // A big hole sits between the two siblings, but it is too small for the
      // requested component and there is no room below the second one either.
      const first = rect({ id: 'a', top: 5, height: 100 }); // bottom 105
      const second = rect({ id: 'b', top: 500, height: 100 }); // bottom 600
      const { layout, siblingUpdates } = generateComponentLayout('Chart', [first, second], { width: 20, height: 400 });

      expect(siblingUpdates).toEqual({ a: { top: GRID.TOP_MIN }, b: { top: 5 + 100 + SIBLING_GAP } });
      expect(layout.top).toBe(115 + 100 + SIBLING_GAP);
      expect(layout.top + layout.height).toBeLessThanOrEqual(GRID.MAX_BOTTOM);
    });

    it('never moves a fixed-layout Tabs during compaction', () => {
      // The Tabs is fixed at top 90 (bottom 1040) and a movable sibling already sits at
      // top 5. A tall component has no free slot (it would overlap the Tabs below top 115),
      // so the fallback compacts the movable siblings and places the new component under them.
      const tabs = rect({ id: 'tabs-1', type: 'Tabs', ...TABS_FIXED_LAYOUT });
      const sibling = rect({ id: 'a', top: 5, height: 100 });
      const { layout, siblingUpdates } = generateComponentLayout('Chart', [tabs, sibling], {
        width: 20,
        height: 400,
      });

      // Tabs is excluded from compaction: it is neither moved nor repositioned, so it is
      // absent from the updates while the movable sibling is recomputed.
      expect(siblingUpdates).toEqual({ a: { top: GRID.TOP_MIN } });
      expect(siblingUpdates).not.toHaveProperty('tabs-1');
      expect(layout.top).toBe(5 + 100 + 10);
      expect(layout.top + layout.height).toBeLessThanOrEqual(GRID.MAX_BOTTOM);
    });
  });

  describe('compactRootLayouts', () => {
    it('stacks siblings top-to-bottom preserving left/width', () => {
      const compacted = compactRootLayouts([
        rect({ id: 'b', left: 20, width: 10, top: 500, height: 60 }),
        rect({ id: 'a', left: 1, top: 100, height: 30 }),
      ]);
      expect(compacted.map(({ id, top, left, width }) => ({ id, top, left, width }))).toEqual([
        { id: 'a', top: GRID.TOP_MIN, left: 1, width: 4 },
        { id: 'b', top: GRID.TOP_MIN + 30 + SIBLING_GAP, left: 20, width: 10 },
      ]);
    });
  });
});
