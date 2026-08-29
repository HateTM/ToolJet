// server/test/modules/ai/unit/controller-guards.spec.ts
//
// Regression spec for the live-stack 500s on every /api/ai/* route: the controller's
// handlers read `@User() user` (user.firstName in fetchZeroStateConfig, user.id in
// listConversations, ...) but shipped with no @UseGuards(JwtAuthGuard, ...) — and this
// codebase has no global APP_GUARD, so passport never ran, request.user stayed undefined
// and every AI endpoint threw a TypeError. This pins the contract the rest of the
// codebase follows (see tooljet-db/controller.ts): every route must declare both the
// JwtAuthGuard (populates request.user) and the AI module's FeatureAbilityGuard.
import 'reflect-metadata';
import { AiController } from '@modules/ai/controller';
import { JwtAuthGuard } from '@modules/session/guards/jwt-auth.guard';
import { FeatureAbilityGuard } from '@modules/ai/ability/guard';

const getRouteMethods = (instance: object): string[] =>
  Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(
    (name) => name !== 'constructor' && typeof (instance as any)[name] === 'function'
  );

const getGuards = (instance: object, methodName: string): any[] => {
  // Nest resolves a route's guards by merging class-level and method-level
  // @UseGuards metadata, so read both.
  const proto = Object.getPrototypeOf(instance);
  const methodHandler = Object.getOwnPropertyDescriptor(proto, methodName)?.value;
  const classHandler = proto.constructor;
  return [
    ...(Reflect.getMetadata('__guards__', methodHandler) ?? []),
    ...(Reflect.getMetadata('__guards__', classHandler) ?? []),
  ];
};

describe('AiController route guards', () => {
  const controller = Object.create(AiController.prototype);

  it('exposes at least one route', () => {
    expect(getRouteMethods(controller).length).toBeGreaterThan(0);
  });

  it.each(getRouteMethods(controller))('guards %s with JwtAuthGuard + FeatureAbilityGuard', (methodName) => {
    const guards = getGuards(controller, methodName);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(FeatureAbilityGuard);
  });
});
