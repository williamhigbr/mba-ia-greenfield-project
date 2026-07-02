# Auth / JWT Rules

Rules for the authentication module in `nestjs-project/src/auth/`.

---

## `jti` is mandatory in every signed token

Every JWT must include a unique `jti` claim (`randomUUID()`). JWT signatures are deterministic — two tokens issued in the same second for the same `sub`/`family` produce identical strings without `jti`, breaking refresh-token rotation.

## Refresh-Token Rotation

- Every refresh issues a new token in the same family and revokes the previous one.
- Reuse of a revoked token (outside grace window) revokes the **entire family** → forces re-login.
- Grace window: brief period after rotation during which the previous token may be re-presented. Return the just-issued token without creating a new one.
- Edge case: if the family is fully revoked (logout or prior reuse detection), the grace-window branch must throw `InvalidTokenException` — never silently return a token for a revoked session.

## Logout

- Revokes every active refresh token in the user's session/family.
- Subsequent uses must fail with `InvalidTokenException` — including tokens in the grace window.

## Password Reset

- On success, revoke every active refresh token for the user.
- Reset tokens use the same `createVerificationToken(userId, type, expirationHours)` helper as email confirmation — do not duplicate.

## Token TTL Types (`StringValue`)

`@nestjs/jwt`'s `signOptions.expiresIn` requires `StringValue` from `ms` package, not plain `string`. Cast at the JWT call-site boundary:

```typescript
import type { StringValue } from 'ms';
signOptions: { expiresIn: config.accessTokenTtl as StringValue }
```

## Global JWT Guard

`JwtAuthGuard` is registered as `APP_GUARD`. Every endpoint is protected by default; use `@Public()` to opt out.

## Rate Limiting

- Auth endpoints are rate-limited via global `ThrottlerGuard`.
- E2E tests must clear throttler storage in `beforeEach` to avoid 429 leakage across describe blocks.
