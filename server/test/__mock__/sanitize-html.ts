// Offline test mock for `sanitize-html` (its htmlparser2 dependency ships ESM-only dist
// under Node 24; jest under Node 24 can't require() it — see jest.ai-unit.config.js's
// header comment for the wider Node-version story). The AI Builder unit tests never
// exercise real HTML sanitization, so returning the input verbatim is sufficient.
// `export =` (not `export default`): source does `import * as sanitizeHtml from
// 'sanitize-html'` and calls it directly, so the mapped module itself must be callable
// (mirroring the real package's `module.exports = function`), not a namespace with a
// `.default` property.
export = jest.fn((value: string) => value);
