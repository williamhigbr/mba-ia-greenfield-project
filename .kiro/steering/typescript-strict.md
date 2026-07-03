# TypeScript Strict Rules

Applies to all TypeScript in the project (`nestjs-project/` and `next-frontend/`).

---

## Compilation

- Both projects compile with `strict` settings. `npx tsc --noEmit` must exit 0 before any task is done.
- Never leave compilation errors as debt for future tasks.

## Type-Only Imports

Use `import type` for imports consumed only as types:

```typescript
import type { JwtPayload } from './types/jwt-payload';
import type { ConfigType } from '@nestjs/config';
```

Mixed modules — inline form:

```typescript
import { someFunction, type SomeType } from './module';
```

## NestJS ConfigType

For typed configs built with `registerAs`, use `ConfigType<typeof myConfig>` (not `ReturnType`) — it resolves async factory promises:

```typescript
import type { ConfigType } from '@nestjs/config';

constructor(
  @Inject(authConfig.KEY)
  private readonly config: ConfigType<typeof authConfig>,
) {}
```

## Strict Null Defaults

Narrow optional env vars before use:

```typescript
const port = parseInt(process.env.PORT ?? '3000', 10);
```

## Library-Specific Type Casts

Some libraries use branded string types. Cast at the boundary where the value enters the library API rather than widening the source type.
