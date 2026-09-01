/**
 * Ticket #67 — the machine-readable catalog of valid ToolJet event types, derived from the
 * platform's own metadata rather than left to the model's imagination:
 *
 * - `EVENT_ACTIONS` mirrors the frontend's action list verbatim
 *   (frontend/src/AppBuilder/RightSideBar/Inspector/ActionTypes.js) — each action id with
 *   the option keys its event body may carry.
 * - `COMPONENT_EVENT_IDS` mirrors each supported widget's `events` block
 *   (frontend/src/AppBuilder/WidgetManager/widgets/*.js) — the event ids a widget of that
 *   type can actually fire.
 * - `QUERY_EVENT_IDS` are the two handlers a data query exposes.
 *
 * ADR-0033 note: the future Generation engine will replace this catalog's consumer; the
 * catalog itself (sourced from platform metadata, one module) is what carries over.
 */

// Every action id mapped to the exact event-body keys it accepts. `control-component`
// follows the runtime body shape (componentId/componentSpecificActionHandle/
// componentSpecificActionParams) the platform's event runner and EE both use — not the
// inspector's display-time option names.
const BASE_EVENT_KEYS = ['eventId', 'actionId', 'message', 'alertType', 'runOnlyIf'] as const;

export const EVENT_ACTIONS: Record<string, string[]> = {
  'run-query': ['queryId'],
  'reset-query': ['queryId'],
  'abort-query': ['queryId'],
  'show-alert': ['message', 'alertType'],
  'show-modal': ['modal'],
  'close-modal': ['modal'],
  'set-table-page': ['table', 'pageIndex'],
  'scroll-component-into-view': ['componentId', 'scrollBehavior', 'scrollBlock'],
  'switch-page': ['page'],
  'go-to-app': ['app', 'queryParams'],
  'open-webpage': ['url'],
  'set-page-variable': ['key', 'value'],
  'unset-page-variable': ['key'],
  'set-custom-variable': ['key', 'value'],
  'unset-custom-variable': ['key'],
  logout: [],
  'generate-file': ['fileType', 'fileName', 'data'],
  'set-localstorage-value': ['key', 'value'],
  'copy-to-clipboard': ['copy-to-clipboard'],
  'toggle-app-mode': ['appMode'],
  'control-component': ['componentId', 'componentSpecificActionHandle', 'componentSpecificActionParams'],
};

// The event ids per component type, from each widget's `events` metadata. Container exposes
// none. Component types outside this map (e.g. the Page pseudo-type) accept no events here —
// event targets are widgets and data queries.
export const COMPONENT_EVENT_IDS: Record<string, string[]> = {
  Button: ['onClick', 'onHover'],
  Table: [
    'onRowHovered',
    'onRowClicked',
    'onExpand',
    'onBulkUpdate',
    'onPageChanged',
    'onSearch',
    'onCancelChanges',
    'onSort',
    'onCellValueChanged',
    'onFilterChanged',
    'onNewRowsAdded',
    'onTableDataDownload',
  ],
  TextInput: ['onChange', 'onEnterPressed', 'onFocus', 'onBlur'],
  Dropdown: ['onSelect', 'onSearchTextChanged'],
  Modal: ['onOpen', 'onClose'],
  Form: ['onSubmit', 'onInvalid'],
  Checkbox: ['onChange', 'onCheck', 'onUnCheck'],
  Chart: ['onClick', 'onDoubleClick'],
  Image: ['onClick'],
  Text: ['onClick', 'onHover'],
  Container: [],
};

export const QUERY_EVENT_IDS = ['onDataQuerySuccess', 'onDataQueryFailure'];

// The quality rule from the EE prompt (ticket #67): the design may say "rowClick", but the
// platform's event id is the camelCase one the widget actually fires. Aliases are matched
// case-insensitively after stripping the leading "on"; anything not listed passes through
// unchanged and must then survive the exact-match validation below.
const EVENT_ID_ALIASES: Record<string, string> = {
  click: 'onClick',
  rowclick: 'onRowClicked',
  rowclicked: 'onRowClicked',
  change: 'onChange',
  submit: 'onSubmit',
  select: 'onSelect',
  hover: 'onHover',
  open: 'onOpen',
  close: 'onClose',
};

export const normalizeEventId = (raw: string): string => {
  if (typeof raw !== 'string') return raw;
  const bare = raw.trim().replace(/^on/i, '').toLowerCase();
  return EVENT_ID_ALIASES[bare] ?? raw.trim();
};

const allowedKeysFor = (actionId: string): Set<string> =>
  new Set([...BASE_EVENT_KEYS, ...(EVENT_ACTIONS[actionId] ?? [])]);

const allowedEventIdsFor = (targetType: 'component' | 'data_query', componentType?: string): string[] =>
  targetType === 'data_query' ? QUERY_EVENT_IDS : (COMPONENT_EVENT_IDS[componentType] ?? []);

/**
 * Validates (and normalizes) one LLM-proposed event body against the catalog. Throws a
 * retryable error naming the allowed values, the same way pageId/queryName validation does —
 * the model picks the event per attempt, so a corrective message is how it self-repairs.
 */
export const validateEventBody = (
  body: Record<string, any>,
  targetType: 'component' | 'data_query',
  componentType?: string
): Record<string, any> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('An event must be an object with at least eventId and actionId');
  }

  const actionId = body.actionId;
  if (typeof actionId !== 'string' || !EVENT_ACTIONS[actionId]) {
    throw new Error(
      `Unknown event actionId "${actionId}". Valid actions are: ${Object.keys(EVENT_ACTIONS).join(', ')}`
    );
  }

  const eventId = normalizeEventId(body.eventId);
  const allowedEventIds = allowedEventIdsFor(targetType, componentType);
  if (!allowedEventIds.includes(eventId)) {
    const target = targetType === 'data_query' ? 'a data query' : `a ${componentType ?? 'component'}`;
    throw new Error(
      `Event id "${eventId}" is not valid on ${target}. Valid event ids are: ${allowedEventIds.join(', ')}`
    );
  }

  const allowedKeys = allowedKeysFor(actionId);
  const unknownKeys = Object.keys(body).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new Error(
      `Unknown event key(s) ${unknownKeys.join(', ')} for action "${actionId}". Allowed keys are: ${[...allowedKeys].join(', ')}`
    );
  }

  if (Object.values(body).some((value) => value === undefined)) {
    throw new Error('Event values must never be undefined — omit a key instead of setting it to undefined');
  }

  if (actionId === 'control-component' && !Array.isArray(body.componentSpecificActionParams)) {
    throw new Error(
      'A control-component event must carry componentSpecificActionParams as an array (even an empty one)'
    );
  }

  return { ...body, eventId };
};

/** The catalog rendered into the generation prompt (ticket #67: "машинный список"). */
export const renderEventCatalogForPrompt = (): string => {
  const actions = Object.entries(EVENT_ACTIONS).map(
    ([id, keys]) => `${id}${keys.length ? ` (keys: ${keys.join(', ')})` : ''}`
  );
  const eventIds = Object.entries(COMPONENT_EVENT_IDS)
    .filter(([, ids]) => ids.length)
    .map(([type, ids]) => `${type}: ${ids.join(', ')}`);
  return [
    'Valid actionIds with the exact keys each accepts:',
    ...actions.map((line) => `- ${line}`),
    '',
    'Valid eventIds per component type:',
    ...eventIds.map((line) => `- ${line}`),
    `- data query: ${QUERY_EVENT_IDS.join(', ')}`,
  ].join('\n');
};
