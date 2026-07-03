import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Auth guard for `@Public()` endpoints that still want to know the caller when
 * a valid token is present (e.g. owner visibility on `GET /videos/:id`). Unlike
 * `JwtAuthGuard`, a missing or invalid token is NOT an error — the request
 * simply proceeds as anonymous (`request.user` stays undefined).
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (authHeader && authHeader.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      } catch {
        // Invalid/expired token on a public route → treat as anonymous.
      }
    }

    return true;
  }
}
