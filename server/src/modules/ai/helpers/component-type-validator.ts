import { getDefaultValue, getValidationSchema, isKnownProperty, WidgetSection } from './widget-meta';

/**
 * Port of the EE component-type-validator (ticket #60): every property of an
 * LLM-generated component is checked against the widget's metadata. Unknown
 * keys are dropped, values that don't match the expected type are replaced by
 * the widget's default — each replacement produces a warning the caller logs
 * and surfaces, and the component renders instead of breaking.
 *
 * `{{...}}` template expressions are never validated as static values: they
 * resolve at runtime against the app's state.
 */
export function isTemplateExpression(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('{{') && value.trim().endsWith('}}');
}

function inferExpectedType(defaultValue: any): string | null {
  if (defaultValue === null || defaultValue === undefined) return null;
  return typeOfValue(defaultValue);
}

/** `typeof` with arrays reported as 'array' (the meta's own type vocabulary). */
function typeOfValue(value: any): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

function isValidForSchema(value: any, schema: any): boolean {
  if (value === null || value === undefined) return true;
  switch (schema?.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)));
    case 'array':
      if (Array.isArray(value)) return true;
      if (typeof value === 'string') {
        try {
          return Array.isArray(JSON.parse(value));
        } catch {
          return false;
        }
      }
      return false;
    case 'object':
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return true;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
        } catch {
          return false;
        }
      }
      return false;
    case 'union':
      return (schema?.schemas ?? []).some((subSchema: any) => isValidForSchema(value, subSchema));
    default:
      return true;
  }
}

export interface SanitizeResult {
  result: Record<string, any>;
  warnings: string[];
}

/**
 * Validates one section (properties/styles/general/validation) of a generated
 * component against the widget meta. Entries are `{ value, ... }` wrappers, as
 * the componentDiff format stores them.
 */
export function sanitizeComponentSection(
  componentType: string,
  section: WidgetSection,
  input: Record<string, any>
): SanitizeResult {
  const warnings: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { result: input, warnings };
  }

  const result: Record<string, any> = {};
  for (const [propName, rawEntry] of Object.entries(input)) {
    const isWrapped =
      rawEntry !== null && typeof rawEntry === 'object' && !Array.isArray(rawEntry) && 'value' in rawEntry;
    const value = isWrapped ? rawEntry.value : rawEntry;

    if (!isKnownProperty(componentType, section, propName)) {
      warnings.push(
        `[component-schema] ${componentType}.${section}.${propName}: unknown property dropped (value: ${JSON.stringify(
          value
        )?.slice(0, 120)})`
      );
      continue;
    }

    const schema = getValidationSchema(componentType, section, propName);
    const defaultValue = getDefaultValue(componentType, section, propName);
    const expectedType = schema ? 'schema' : inferExpectedType(defaultValue);
    // A default that is itself a template (e.g. visibility: '{{true}}') carries no static
    // type information — any incoming static value is accepted as-is rather than being
    // "corrected" into the template (which would silently invert semantics like hideOnEsc).
    const defaultIsTemplate = !schema && typeof defaultValue === 'string' && isTemplateExpression(defaultValue);
    const valid =
      isTemplateExpression(value) ||
      value === null ||
      value === undefined ||
      defaultIsTemplate ||
      (schema ? isValidForSchema(value, schema) : expectedType === null || typeOfValue(value) === expectedType);

    if (!valid) {
      const fallback = getDefaultValue(componentType, section, propName);
      warnings.push(
        `[component-schema] ${componentType}.${section}.${propName}: invalid value ${JSON.stringify(value)?.slice(
          0,
          120
        )} (expected ${schema?.type ?? expectedType}), using default`
      );
      result[propName] = isWrapped ? { ...rawEntry, value: fallback } : fallback;
    } else {
      result[propName] = rawEntry;
    }
  }

  return { result, warnings };
}
