import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/** Returns the authenticated user injected by `JwtStrategy.validate`. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});
