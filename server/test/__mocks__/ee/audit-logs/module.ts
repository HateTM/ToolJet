// server/test/__mocks__/ee/audit-logs/module.ts
//
// CE-fork stand-in for the private EE audit-logs module. The DB-backed test harness
// (test/helpers/setup.ts) registers AuditLogsModule into every test app, but this fork's
// server/ee is an unpopulated private submodule (CE-only). The stub registers no providers:
// audit logging is an EE feature, and no CE test asserts on it.
import { DynamicModule } from '@nestjs/common';

export class AuditLogsModule {
  static register(_options?: Record<string, any>): DynamicModule {
    return { module: AuditLogsModule, providers: [], exports: [] };
  }
}
