import { getDefaultValue } from './widget-meta';
import { isTemplateExpression } from './component-type-validator';

/**
 * Port of the EE component-options.utils (ticket #60), without the acorn parse:
 * LLM output for a widget's `options` property comes in as a structure-broken
 * value more often than as a clean array — a string of concatenated option
 * objects, a char-object array (each entry `{ '0': '<chunk>' }`), a quoted
 * `{{[...]}}` expression — and the structural fixes below reconstruct a valid
 * option list from it. Anything unrecoverable falls back to the widget's
 * default options, then to an empty array. Every fallback is reported as a
 * warning so the caller can surface it.
 */

function isCharacterObjectArray(value: any): value is Array<Record<'0', string>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 1 &&
        Object.prototype.hasOwnProperty.call(entry, '0') &&
        typeof entry['0'] === 'string'
    )
  );
}

function normalizeBooleanOptionFlag(value: any, fallback: boolean) {
  if (typeof value === 'boolean') return { value };
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return { value: !!value.value };
  }
  return { value: fallback };
}

function toWidgetOption(option: any) {
  const label = option.label ?? option.name ?? option.title ?? '';
  const rawOptionValue = option.value ?? option.id ?? label;
  return {
    label: typeof label === 'string' ? label : String(label),
    value: typeof rawOptionValue === 'string' ? rawOptionValue : String(rawOptionValue ?? ''),
    caption: option.caption === null || option.caption === undefined ? null : String(option.caption),
    disable: normalizeBooleanOptionFlag(option.disable, false),
    visible: normalizeBooleanOptionFlag(option.visible, true),
    default: normalizeBooleanOptionFlag(option.default, false),
  };
}

/** Best-effort static parse of an options string — JSON only, no JS evaluation. */
function parseStaticOptions(rawValue: string): any[] | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    candidates.unshift(trimmed.slice(2, -2).trim());
  }
  // A whole quoted JSON document (the LLM re-serialized the array into a string).
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) {
    candidates.unshift(trimmed.slice(1, -1));
  }
  // LLM output often uses single quotes; a naive quote swap recovers most of those.
  candidates.push(...candidates.map((candidate) => candidate.replace(/'/g, '"')));
  // ...and unquoted object keys ({label: 'x'}) — quote the identifiers as a last repair.
  const keyQuoteRegex = /([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g;
  candidates.push(...candidates.map((candidate) => candidate.replace(keyQuoteRegex, '$1"$2"$3')));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const options = parsed
          .filter((option) => option && typeof option === 'object' && !Array.isArray(option))
          .map(toWidgetOption);
        return options.length > 0 ? options : null;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export interface NormalizeOptionsResult {
  warnings: string[];
}

/**
 * Repairs `properties.options.value` in place for a generated component.
 * `fallbackProperties` is the same widget's default definition (meta), used as
 * the last-resort option list.
 */
export function normalizeMalformedOptionsProperty(
  componentType: string,
  properties: Record<string, any>,
  fallbackProperties?: Record<string, any>
): NormalizeOptionsResult {
  const warnings: string[] = [];
  const optionsEntry = properties?.options;
  if (!optionsEntry || typeof optionsEntry !== 'object') return { warnings };

  const rawValue = optionsEntry.value;
  let reconstructed: string | null = null;

  if (isCharacterObjectArray(rawValue)) {
    reconstructed = rawValue.map((entry) => entry['0']).join('');
    warnings.push(`[component-schema] ${componentType}.properties.options: char-object array reconstructed`);
  } else if (typeof rawValue === 'string') {
    reconstructed = rawValue;
  } else if (Array.isArray(rawValue)) {
    // Already an array — normalize entries but keep it. Plain strings map to
    // { label, value }; non-object entries are dropped.
    const normalized = rawValue
      .map((option) => (typeof option === 'string' ? { label: option, value: option } : option))
      .filter((option) => option && typeof option === 'object' && !Array.isArray(option))
      .map(toWidgetOption);
    if (normalized.length > 0) {
      properties.options = { ...optionsEntry, value: normalized };
      return { warnings };
    }
    // Nothing usable in the array — fall through to the recovery paths below.
    reconstructed = null;
  } else {
    // Neither array, string, nor char-array — unrecoverable, fall through to fallbacks.
    reconstructed = null;
  }

  const parsedOptions = reconstructed === null ? null : parseStaticOptions(reconstructed);
  if (parsedOptions) {
    properties.options = { ...optionsEntry, value: parsedOptions };
    if (isCharacterObjectArray(rawValue)) return { warnings };
    warnings.push(`[component-schema] ${componentType}.properties.options: malformed options normalized`);
    return { warnings };
  }

  if (isTemplateExpression(reconstructed)) {
    // A live template binding — leave it for runtime resolution.
    properties.options = { ...optionsEntry, value: reconstructed };
    return { warnings };
  }

  const fallbackOptions = getDefaultValue(componentType, 'properties', 'options');
  warnings.push(
    `[component-schema] ${componentType}.properties.options: unrecoverable options (source: ${String(
      reconstructed ?? JSON.stringify(rawValue)
    ).slice(0, 120)}), using ${fallbackOptions ? 'widget defaults' : 'empty list'}`
  );
  properties.options = {
    ...optionsEntry,
    value: fallbackOptions ? JSON.parse(JSON.stringify(fallbackOptions)) : [],
  };
  return { warnings };
}
