// Offline test mock for the plugins barrel (`@tooljet/plugins/dist/server`).
//
// The real barrel imports all 47 data-source packages; under this environment's
// Node 24 that surface triggers a jest `__esModule` collision and a `got`
// ESM require() failure. The AI Builder unit specs only need two re-exported
// errors from it, so this minimal stub stands in for the whole barrel.
export class QueryError extends Error {
  constructor(message?: string) {
    super(message ?? 'Query error');
    this.name = 'QueryError';
  }
}

export class OAuthUnauthorizedClientError extends Error {
  constructor(message?: string) {
    super(message ?? 'OAuth unauthorized client');
    this.name = 'OAuthUnauthorizedClientError';
  }
}

// allPlugins[kind] is only referenced from plugin-selector.service, which the
// AI Builder unit specs never load. An empty object is enough to keep the
// barrel import from throwing.
export default {};
