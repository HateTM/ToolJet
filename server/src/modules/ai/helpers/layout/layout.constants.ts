/**
 * Ticket #63 — deterministic layout generation for AI Builder-created components.
 *
 * Ported from the EE layout rules (ee-ai-extract prompt-library/generateLayout.js)
 * as code instead of LLM prompts: the ToolJet grid, fixed layouts (Tabs, Modal via
 * trigger-button) and the per-widget default footprints. Coordinates themselves are
 * computed by generate-layout.ts — never proposed by the model.
 */

/** The ToolJet desktop grid, in count units. */
export const GRID = {
  LEFT_MIN: 1,
  LEFT_MAX: 40,
  TOP_MIN: 5,
  TOP_MAX: 970,
  WIDTH_MAX: 40,
  /** left + width must not exceed this. */
  MAX_RIGHT: 42,
  /** top + height must not exceed this. */
  MAX_BOTTOM: 1000,
} as const;

/** Minimum vertical breathing room between sibling components. */
export const SIBLING_GAP = 10;

/**
 * Tabs is a full-page container: exactly one per page, never nested, always at
 * this fixed position (ee-ai-extract generateLayout.js rules). Note the ticket-
 * specified footprint deliberately exceeds the ordinary MAX_BOTTOM of 1000 —
 * Tabs is the one component exempt from that invariant, so compaction and
 * grid clamps must never touch it (see generate-layout.ts).
 */
export const TABS_FIXED_LAYOUT = { height: 950, width: 41, top: 90, left: 1 } as const;

/**
 * Default canvas footprint (grid count units) per widget type. Mirrors each
 * widget's own `defaultSize` in frontend/src/AppBuilder/WidgetManager/widgets/*.js
 * — the same values the typed builders in agents.service.ts pass in.
 */
export const DEFAULT_COMPONENT_SIZES: Record<string, { width: number; height: number }> = {
  Button: { width: 4, height: 40 },
  Checkbox: { width: 6, height: 30 },
  Chart: { width: 20, height: 400 },
  Container: { width: 15, height: 450 },
  DropdownV2: { width: 10, height: 40 },
  Image: { width: 10, height: 240 },
  Modal: { width: 10, height: 34 },
  Table: { width: 25, height: 460 },
  Text: { width: 6, height: 40 },
  TextInput: { width: 10, height: 40 },
  // Wave 1 (plan increment 3): mirrors each widget's own defaultSize in
  // frontend/src/AppBuilder/WidgetManager/widgets/*.js.
  TextArea: { width: 10, height: 100 },
  PasswordInput: { width: 10, height: 40 },
  NumberInput: { width: 10, height: 40 },
  EmailInput: { width: 10, height: 40 },
  Link: { width: 6, height: 30 },
  Divider: { width: 10, height: 10 },
  Icon: { width: 5, height: 48 },
  StarRating: { width: 10, height: 30 },
  Statistics: { width: 10, height: 152 },
  Tags: { width: 9, height: 30 },
  CurrencyInput: { width: 10, height: 40 },
  PhoneInput: { width: 10, height: 40 },
  Datepicker: { width: 5, height: 40 },
  // Wave 2 (plan increment 3): 'Tabs' is special-cased to TABS_FIXED_LAYOUT above and never
  // reads this entry, but it's listed for documentation symmetry with widgetConfig.js.
  Tabs: { width: 15, height: 450 },
  Listview: { width: 15, height: 450 },
  IFrame: { width: 10, height: 310 },
  FilePicker: { width: 15, height: 140 },
  ModalV2: { width: 10, height: 40 },
  TreeSelect: { width: 12, height: 200 },
  Html: { width: 10, height: 310 },
  PopoverMenu: { width: 6, height: 40 },
  ButtonGroupV2: { width: 12, height: 80 },
  DatePickerV2: { width: 10, height: 40 },
  Chat: { width: 15, height: 400 },
};
