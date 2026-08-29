// Offline test mock for `got` (got v14 is ESM-only; jest under Node 24 can't
// require() it). The AI Builder unit tests never issue real baserow network
// calls, so a no-op default export is sufficient. No `__esModule` flag: jest
// freezes the module object and the assignment would collide.
export default jest.fn();
