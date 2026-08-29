// Offline test mock for `isolated-vm` (v5 ships a native binding that fails to
// build on this environment's Node 24). The AI Builder unit specs never execute
// the RunJS data-source runtime, so empty stand-in classes are enough to let the
// module graph load. No `__esModule` flag (jest freezes the module object).
export class Isolate {}
export class Context {}
export class Script {}
export class Callback {}
export class ExternalCopy {}
