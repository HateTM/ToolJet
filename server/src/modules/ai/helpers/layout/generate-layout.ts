/**
 * Ticket #63 — deterministic coordinate generation for AI Builder-created
 * components. All functions are pure: given the widget type, the existing
 * root-level sibling rectangles on the page and an (optional) desired size,
 * they return grid-valid coordinates without ever proposing an overlap.
 *
 * Children of containers are not part of this — they live in their parent's
 * own coordinate space, so only root-level siblings (parent === null) are
 * considered here.
 */
import { GRID, SIBLING_GAP, TABS_FIXED_LAYOUT, DEFAULT_COMPONENT_SIZES } from './layout.constants';

export interface SiblingRect {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComponentLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GeneratedLayout {
  layout: ComponentLayout;
  /**
   * Only set when the page was too full to fit the new component without
   * moving existing ones: the recomputed tops of the compacted siblings,
   * keyed by component id, to be written back as layout diffs.
   */
  siblingUpdates: Record<string, { top: number }> | null;
}

const overlapsWithGap = (a: ComponentLayout, b: SiblingRect): boolean =>
  a.top < b.top + b.height + SIBLING_GAP &&
  a.top + a.height + SIBLING_GAP > b.top &&
  a.left < b.left + b.width &&
  a.left + a.width > b.left;

/**
 * Clamps a desired footprint to the grid: width into [1, 40] so left(1) +
 * width <= 42 always holds; height capped so a top-min placement still fits
 * under MAX_BOTTOM.
 */
export const clampSizeToGrid = (width: number, height: number): { width: number; height: number } => ({
  width: Math.max(1, Math.min(Math.round(width) || 1, GRID.WIDTH_MAX)),
  height: Math.max(1, Math.min(Math.round(height) || 1, GRID.MAX_BOTTOM - GRID.TOP_MIN)),
});

/**
 * Picks the default footprint for a widget type, falling back to a small
 * generic box for unknown types (they must still render grid-valid).
 */
export const getDefaultSize = (type: string): { width: number; height: number } =>
  DEFAULT_COMPONENT_SIZES[type] ?? { width: 10, height: 40 };

/**
 * Generates grid-valid coordinates for a new root-level component.
 *
 * Tabs follows the fixed full-page layout and is limited to one per page
 * (throws if a Tabs already exists). Modal — like every other type — is placed
 * as a normal component; its open trigger is the widget's own trigger-button
 * (useDefaultButton), which the Modal builder sets. Everything else scans
 * downward from the top of the page for the first vertical slot that keeps
 * SIBLING_GAP clear of every sibling; when the page is already full to the
 * bottom, siblings are compacted (recomputed) to make room — the caller must
 * persist the returned siblingUpdates.
 */
export const generateComponentLayout = (
  type: string,
  siblings: SiblingRect[],
  desiredSize?: { width: number; height: number }
): GeneratedLayout => {
  if (type === 'Tabs') {
    if (siblings.some((sibling) => sibling.type === 'Tabs')) {
      throw new Error('A Tabs component already exists on this page — ToolJet allows only one Tabs per page');
    }
    return { layout: { ...TABS_FIXED_LAYOUT }, siblingUpdates: null };
  }

  const { width, height } = clampSizeToGrid(
    desiredSize?.width ?? getDefaultSize(type).width,
    desiredSize?.height ?? getDefaultSize(type).height
  );

  // Deterministic candidate tops: page top, then just below every sibling.
  const candidateTops = [GRID.TOP_MIN, ...siblings.map((sibling) => sibling.top + sibling.height + SIBLING_GAP)]
    .filter((top) => top >= GRID.TOP_MIN)
    .sort((a, b) => a - b);

  for (const top of candidateTops) {
    if (top + height > GRID.MAX_BOTTOM) break;
    const candidate: ComponentLayout = { left: GRID.LEFT_MIN, top, width, height };
    if (!siblings.some((sibling) => overlapsWithGap(candidate, sibling))) {
      return { layout: candidate, siblingUpdates: null };
    }
  }

  // No free slot anywhere below the grid top — compact the siblings into a
  // gap-respecting vertical stack and place the new component under them. Tabs
  // keeps its fixed layout and is never moved (nor can the new component be
  // placed under it, so it is excluded from the constraint set). If even the
  // compacted stack cannot fit the component, the top is clamped to keep the
  // footprint grid-valid (the last-resort overlap is geometrically unavoidable).
  const movable = siblings.filter((sibling) => sibling.type !== 'Tabs');
  const compacted = compactRootLayouts(movable);
  const last = compacted[compacted.length - 1];
  const top = last ? last.top + last.height + SIBLING_GAP : GRID.TOP_MIN;
  return {
    layout: {
      left: GRID.LEFT_MIN,
      top: Math.max(Math.min(top, GRID.MAX_BOTTOM - height), GRID.TOP_MIN),
      width,
      height,
    },
    siblingUpdates: compacted.length
      ? Object.fromEntries(compacted.map(({ id, top: siblingTop }) => [id, { top: siblingTop }]))
      : null,
  };
};

/**
 * Recomputes the tops of root-level siblings so they stack top-to-bottom with
 * SIBLING_GAP between them, keeping each component's own left/width. Returns
 * the entries sorted by their original top, each carrying its new top.
 */
export const compactRootLayouts = (siblings: SiblingRect[]): Array<SiblingRect & { top: number }> => {
  const sorted = [...siblings].sort((a, b) => a.top - b.top || a.left - b.left);
  let cursor = GRID.TOP_MIN;
  return sorted.map((sibling) => {
    const top = cursor;
    cursor = top + sibling.height + SIBLING_GAP;
    return { ...sibling, top };
  });
};
