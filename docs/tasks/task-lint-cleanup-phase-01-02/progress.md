# task-lint-cleanup-phase-01-02 — Progress

**Status:** completed
**SIs:** 4/4 completed
**Baseline:** 150 errors / 40 warnings → **Final: 0 errors / 20 warnings** (warnings are the intentionally-downgraded `no-unsafe-argument`; halved from 40 as a side benefit of typing). Lint gate exits 0. tsc=0. Suite: 184 unit/integration + 71 e2e passing.

### SI-1 — ESLint: eslint-plugin-jest + test override
- **Status:** completed
- **Tests:** config only
- **Observations:**
  - Installed `eslint-plugin-jest@29.15.4` (dev). Added a test-file override (`**/*.spec.ts`, `**/*.integration-spec.ts`, `test/**/*.ts`) that registers the `jest` plugin, turns off core `@typescript-eslint/unbound-method`, and enables `jest/unbound-method`. This is the idiomatic fix for the `expect(mock.method).toHaveBeenCalledWith(...)` pattern (all 19 unbound-method errors were in `auth.service.spec.ts`).
  - Errors 150 → 131. Config loads clean.

### SI-2 — Produção + infra: channels.service.ts + create-test-data-source.ts
- **Status:** completed
- **Tests:** channels.service.integration-spec 3/3
- **Observations:**
  - `channels.service.ts`: replaced `const e = err as any` with a typed `interface PgDriverError { code?; detail? }` narrowing over `err.driverError`. **Behavior change note:** production now reads `err.driverError.code/detail` (the pg error) instead of the copied props on `QueryFailedError` — so `channels.service.spec.ts`'s `makeUniqueError` had to be updated (SI-4) to place code/detail on `driverError`, else the concurrent-collision unit test would break.
  - `create-test-data-source.ts`: replaced the bare `Function` param type with `NonNullable<DataSourceOptions['entities']>` (dropped `EntitySchema`, imported `DataSourceOptions`).
  - Errors 131 → 124.

### SI-3 — E2E: tipar res.body em auth.e2e-spec.ts
- **Status:** completed
- **Tests:** auth.e2e 45/45
- **Observations:**
  - Added 4 typed body interfaces (`ErrorEnvelope`/`AuthTokens`/`RegisteredUser`/`AuthProfile`); cast all `res.body.*` accesses.
  - Swapped the two `(authService as any).mailService` capture helpers to `app.get(MailService)` (removed `as any`), and made the `mockImplementationOnce` non-async returning `Promise.resolve()` (fixed `require-await`). Removed the now-unused `AuthService` import.
  - **Gotcha:** `loginRes.body.access_token` contains `res.body.access_token` as a substring — cast the `loginRes` access first, before the generic `res.body.access_token` replaceAll, to avoid corruption.
  - Errors 124 → 76.

### SI-4 — Unit/integration specs restantes
- **Status:** completed
- **Tests:** full suite — 184 unit/integration + 71 e2e passing
- **Observations:**
  - `test/mailpit.ts`: typed the helper responses at the source (`MailpitMessageSummary`/`MailpitMessageDetail`/`MailpitAddress`) — this cleared all 16 errors in `mail.service.integration-spec.ts` at once.
  - `auth.service.spec.ts`: typed ~13 partial mock records via `as unknown as VerificationToken | RefreshToken | User` (by describe block); added `User`/`SelectQueryBuilder` imports. Member accesses (`record.used_at`, `.revoked_at`, `user.is_confirmed`, `.password`) auto-resolved once the declarations were typed.
  - `channels.service.spec.ts`: introduced a `MockManager` type; typed `makeManager`/`makeDataSource` (returns `DataSource` via `as unknown as`); rewrote `makeUniqueError` to build a driverError object carrying `code`/`detail` (required by the SI-2 production change).
  - `auth.service.integration-spec.ts`: same `MailService` cast pattern via `(authService as unknown as { mailService: MailService })`; non-async mocks; dropped an unused `userId` destructure.
  - Filter specs: `switchToRpc/switchToWs: () => ({}) as any` → `() => ({})`; `message: expect.any(String)` → `... as unknown` (the matcher returns `any`, which triggers `no-unsafe-assignment` inside object literals). Same `as unknown` fix for `{ revoked_at: expect.any(Date) }` in the logout test.
  - `env.validation.integration-spec.ts`: the Joi `.validate<T>()` generic did NOT propagate to `value` in the installed `@types` — cast the destructure to `{ value: { SWAGGER_ENABLED: string }; error?: unknown }` instead.
  - `users.service.integration-spec.ts`: removed unused `TestingModule` import.
  - Final: 0 errors. `npx eslint "{src,apps,libs,test}/**/*.ts"` exits 0; `tsc --noEmit` = 0.
