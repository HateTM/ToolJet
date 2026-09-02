/**
 * Shared types for the component and event catalogs.
 *
 * Both catalogs exist to be *consumed*, not duplicated, by later pipeline
 * stages (per-entity generation, event generation -- ADR-0028) once those
 * stages exist. Ticket #92 ships the catalogs and their lookup API; no
 * consumer exists yet (#90 is scaffold only), so `toPromptContext()` on each
 * catalog is the seam a future stage calls into.
 */

/** How a component property's value is shaped/bound in a generated app. */
export type PropertyValueType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'dynamic';

export interface ComponentPropertySpec {
  /** Property key as written into the component's `definition.properties`. */
  name: string;
  valueType: PropertyValueType;
  /** Omitted when the fork's only recorded default was demo/seed data (see component-catalog.ts). */
  defaultValue?: unknown;
}

export interface ComponentTriggerSpec {
  /** Event id a generated event handler's `eventId` must match, e.g. 'onRowClicked'. */
  id: string;
  displayName: string;
}

export interface ComponentCatalogEntry {
  name: string;
  category: 'data' | 'input' | 'display' | 'layout';
  properties: ComponentPropertySpec[];
  /** Triggers this component can raise -- the per-component half of the event vocabulary. */
  triggers: ComponentTriggerSpec[];
}

/** How an event action's option value is entered/bound. */
export type EventActionOptionType = 'text' | 'code';

export interface EventActionOption {
  name: string;
  type: EventActionOptionType;
  default?: unknown;
}

export interface EventActionSpec {
  /** Kebab-case id, e.g. 'run-query' -- what `EventsService.createEvent` persists as `actionId`. */
  id: string;
  name: string;
  group: string;
  options: EventActionOption[];
}
