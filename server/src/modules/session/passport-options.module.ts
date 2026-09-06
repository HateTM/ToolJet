import { Global, Module } from '@nestjs/common';
import { AuthModuleOptions } from '@nestjs/passport';

/**
 * @nestjs/passport v12 injects AuthModuleOptions into every AuthGuard-based
 * guard. Many modules use JwtAuthGuard without importing PassportModule, so
 * provide empty default options globally (explicit type means defaultStrategy
 * is never needed).
 */
@Global()
@Module({
  providers: [{ provide: AuthModuleOptions, useValue: {} }],
  exports: [{ provide: AuthModuleOptions, useValue: {} }],
})
export class PassportOptionsModule {}
