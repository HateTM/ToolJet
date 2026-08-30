import * as componentsMeta from './componentsMeta.json';

/**
 * Server-side snapshot of the frontend widget definitions
 * (frontend/src/AppBuilder/WidgetManager/widgets/*.js) for the widget types the
 * AI Builder can create, trimmed from the full generated meta. Used by the
 * schema validation/normalization helpers to reject hallucinated LLM output
 * (ticket #60). Regenerate/extend when a new component type joins
 * AgentsService.CreateComponent.
 */
export type WidgetSection = 'properties' | 'styles' | 'general' | 'validation' | 'others';

export function getWidgetMeta(componentType: string): any {
  return (componentsMeta as any)[componentType] ?? null;
}

export function isKnownProperty(componentType: string, section: WidgetSection, propName: string): boolean {
  const meta = getWidgetMeta(componentType);
  return !!meta?.definition?.[section]?.[propName];
}

/**
 * The EE-generated meta carries an explicit `validation.schema` per property.
 * When it is absent (as in this trimmed snapshot), the property's default value
 * doubles as the type oracle: an incoming static value must be typeof-compatible
 * with what the widget ships by default.
 */
export function getValidationSchema(componentType: string, section: WidgetSection, propName: string): any {
  const meta = getWidgetMeta(componentType);
  return meta?.definition?.[section]?.[propName]?.validation?.schema ?? null;
}

export function getDefaultValue(componentType: string, section: WidgetSection, propName: string): any {
  const meta = getWidgetMeta(componentType);
  return meta?.definition?.[section]?.[propName]?.value;
}
