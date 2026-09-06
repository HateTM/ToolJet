import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Ability, MongoQuery } from '@casl/ability';
import { cloneDeep } from 'lodash';

export const AbilityDecorator = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): Ability<[any, any], MongoQuery> => {
    const request = ctx.switchToHttp().getRequest();
    return cloneDeep(request.tj_ability) as Ability<[any, any], MongoQuery>;
  }
);

// casl v7: Ability uses unique-symbol keyed internals and cannot be
// extended by an interface, so this is a type alias now.
export type AppAbility = Ability<[any, any], MongoQuery>;
