// transit copy from PR #92 (feature/92-generation-engine-catalogs @ fc192cb7db) — dedupe at merge
/**
 * Lookup API over the component and event catalogs -- the seam per-entity/event generation
 * (ADR-0028, not yet built) is meant to call into, per AC "consumed by, not duplicated in,
 * downstream pipeline stages" (ticket #92). No such stage exists yet in this branch (#90 is
 * scaffold only), so nothing calls these functions today; `toPromptContext()` is what makes
 * "injectable into generation prompts" concrete ahead of that consumer existing.
 */
import { COMPONENT_CATALOG } from './component-catalog';
import { EVENT_CATALOG } from './event-catalog';
import type { ComponentCatalogEntry, ComponentTriggerSpec, EventActionSpec } from './types';

export * from './types';
export { COMPONENT_CATALOG } from './component-catalog';
export { EVENT_CATALOG } from './event-catalog';

/** Component names the catalog covers, e.g. for a generation prompt's allow-list. */
export function listComponentNames(): string[] {
  return Object.keys(COMPONENT_CATALOG);
}

export function getComponent(name: string): ComponentCatalogEntry | undefined {
  return COMPONENT_CATALOG[name];
}

/** All triggers a component can raise, or `undefined` if the component itself is unknown. */
export function getComponentTriggers(name: string): ComponentTriggerSpec[] | undefined {
  return COMPONENT_CATALOG[name]?.triggers;
}

/** Whether `triggerId` (e.g. 'onRowClicked') is one this component actually raises. */
export function isValidTrigger(componentName: string, triggerId: string): boolean {
  return COMPONENT_CATALOG[componentName]?.triggers.some((t) => t.id === triggerId) ?? false;
}

export function listEventActionIds(): string[] {
  return Object.keys(EVENT_CATALOG);
}

export function getEventAction(actionId: string): EventActionSpec | undefined {
  return EVENT_CATALOG[actionId];
}

export function isValidEventAction(actionId: string): boolean {
  return actionId in EVENT_CATALOG;
}

/**
 * Compact, JSON-serializable summary of both catalogs for injection into a generation prompt --
 * smaller than the full catalogs (drops nothing structurally, but is the single call a prompt
 * builder needs rather than reaching into both catalog objects itself).
 */
export function toPromptContext(): {
  components: Record<string, ComponentCatalogEntry>;
  eventActions: Record<string, EventActionSpec>;
} {
  return {
    components: COMPONENT_CATALOG,
    eventActions: EVENT_CATALOG,
  };
}
