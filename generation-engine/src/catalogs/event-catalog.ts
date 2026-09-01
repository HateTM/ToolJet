// Sourced from frontend/src/AppBuilder/RightSideBar/Inspector/ActionTypes.js -- the platform's
// real event-action vocabulary, confirmed as the persisted shape by
// server/src/modules/ai/services/agents.service.ts's `eventsService.createEvent(...)` call, which
// writes `actionId: 'run-query'` (kebab-case) into the `event_handler` entity. NOT the camelCase
// `ACTIONS` list in frontend/src/AppBuilder/_stores/constants/actions.js -- that is a code-hint
// list for the expression editor, a different (and non-overlapping) id vocabulary, and does not
// match what `event_handler` actually stores.
//
// This is the standalone half of the event vocabulary: an action an event handler runs. The other
// half -- which triggers ("onClick", "onRowClicked", ...) a component can raise -- lives per
// component in component-catalog.ts, since triggers are not global the way actions are.
//
// Per ADR-0033: modeled on the EE reference's `TooljetEvents` structure (id/name/options), not
// migrated from any fork code -- the fork has no event catalog today (agents.service.ts hardcodes
// a single 'onSubmit'/'run-query' pair). See docs/adr/0033-generation-engine-component-event-catalogs.md.
import type { EventActionSpec } from './types';

export const EVENT_CATALOG: Record<string, EventActionSpec> = {
  'run-query': {
    id: 'run-query',
    name: 'Run query',
    group: 'run-action',
    options: [{ name: 'queryId', type: 'text' }],
  },
  'reset-query': {
    id: 'reset-query',
    name: 'Reset query',
    group: 'run-action',
    options: [{ name: 'queryId', type: 'text' }],
  },
  'abort-query': {
    id: 'abort-query',
    name: 'Abort query',
    group: 'run-action',
    options: [{ name: 'queryId', type: 'text' }],
  },
  'show-alert': {
    id: 'show-alert',
    name: 'Show Alert',
    group: 'run-action',
    options: [{ name: 'message', type: 'text', default: 'Message !' }],
  },
  'control-component': {
    id: 'control-component',
    name: 'Control component',
    group: 'control-component',
    options: [
      { name: 'component', type: 'text', default: '' },
      { name: 'action', type: 'text', default: '' },
    ],
  },
  'show-modal': {
    id: 'show-modal',
    name: 'Show modal',
    group: 'control-component',
    options: [{ name: 'modal', type: 'text', default: '' }],
  },
  'close-modal': {
    id: 'close-modal',
    name: 'Close modal',
    group: 'control-component',
    options: [{ name: 'modal', type: 'text', default: '' }],
  },
  'set-table-page': {
    id: 'set-table-page',
    name: 'Set table page',
    group: 'control-component',
    options: [
      { name: 'table', type: 'text', default: '' },
      { name: 'pageIndex', type: 'text', default: '{{1}}' },
    ],
  },
  'scroll-component-into-view': {
    id: 'scroll-component-into-view',
    name: 'Scroll component into view',
    group: 'control-component',
    options: [
      { name: 'componentId', type: 'text', default: '' },
      { name: 'scrollBehavior', type: 'text', default: 'smooth' },
      { name: 'scrollBlock', type: 'text', default: 'nearest' },
    ],
  },
  'switch-page': {
    id: 'switch-page',
    name: 'Switch page',
    group: 'navigation',
    options: [{ name: 'page', type: 'text', default: '' }],
  },
  'go-to-app': {
    id: 'go-to-app',
    name: 'Go to app',
    group: 'navigation',
    options: [
      { name: 'app', type: 'text', default: '' },
      { name: 'queryParams', type: 'code', default: '[]' },
    ],
  },
  'open-webpage': {
    id: 'open-webpage',
    name: 'Open webpage',
    group: 'navigation',
    options: [{ name: 'url', type: 'text', default: 'https://example.com' }],
  },
  'set-page-variable': {
    id: 'set-page-variable',
    name: 'Set page variable',
    group: 'variable',
    options: [
      { name: 'key', type: 'code', default: '' },
      { name: 'value', type: 'code', default: '' },
    ],
  },
  'unset-page-variable': {
    id: 'unset-page-variable',
    name: 'Unset page variable',
    group: 'variable',
    options: [
      { name: 'key', type: 'code', default: '' },
      { name: 'value', type: 'code', default: '' },
    ],
  },
  'unset-all-page-variables': {
    id: 'unset-all-page-variables',
    name: 'Unset all page variables',
    group: 'variable',
    options: [],
  },
  'set-custom-variable': {
    id: 'set-custom-variable',
    name: 'Set variable',
    group: 'variable',
    options: [
      { name: 'key', type: 'code', default: '' },
      { name: 'value', type: 'code', default: '' },
    ],
  },
  'unset-custom-variable': {
    id: 'unset-custom-variable',
    name: 'Unset variable',
    group: 'variable',
    options: [{ name: 'key', type: 'code', default: '' }],
  },
  'unset-all-custom-variables': {
    id: 'unset-all-custom-variables',
    name: 'Unset all variables',
    group: 'variable',
    options: [],
  },
  logout: {
    id: 'logout',
    name: 'Logout',
    group: 'other',
    options: [],
  },
  'generate-file': {
    id: 'generate-file',
    name: 'Generate file',
    group: 'other',
    options: [
      { name: 'fileType', type: 'text', default: '' },
      { name: 'fileName', type: 'text', default: '' },
      { name: 'data', type: 'code', default: '{{[]}}' },
    ],
  },
  'set-localstorage-value': {
    id: 'set-localstorage-value',
    name: 'Set local storage',
    group: 'other',
    options: [
      { name: 'key', type: 'code', default: '' },
      { name: 'value', type: 'code', default: '' },
    ],
  },
  'copy-to-clipboard': {
    id: 'copy-to-clipboard',
    name: 'Copy to clipboard',
    group: 'other',
    options: [{ name: 'copy-to-clipboard', type: 'text', default: '' }],
  },
  'toggle-app-mode': {
    id: 'toggle-app-mode',
    name: 'Toggle app mode',
    group: 'other',
    options: [{ name: 'appMode', type: 'text', default: '' }],
  },
};
