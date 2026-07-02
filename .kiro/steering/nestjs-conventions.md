# NestJS Conventions

Rules for `nestjs-project/` — controllers, services, modules, entities, DTOs, layer separation, and testing.

---

## Naming

| Artifact   | File Name              | Class Name          |
|---|---|---|
| Module     | `users.module.ts`      | `UsersModule`       |
| Service    | `users.service.ts`     | `UsersService`      |
| Controller | `users.controller.ts`  | `UsersController`   |
| Entity     | `user.entity.ts`       | `User`              |
| DTO        | `create-user.dto.ts`   | `CreateUserDto`     |
| Guard      | `auth.guard.ts`        | `AuthGuard`         |
| Constants  | `auth.constants.ts`    | (named exports)     |

- Files: kebab-case. Classes: PascalCase. Modules: pluralize. Entities: singularize.
- Variables/Functions: camelCase.

## Dependency Injection

- Inject via constructor: `constructor(private readonly service: SomeService) {}`
- Never `new` to instantiate services. Use `private readonly`; `protected` only for subclasses.
- Use `@Inject()` only for custom providers with string/symbol tokens.

## Async/Await

- Every I/O method: `async` with explicit `Promise<T>` return type.
- Use `await`, never `.then()` / `.catch()`. No un-awaited Promises.

## Constants

- Repeated strings/numbers in `<module>.constants.ts`. Always `as const` for literal types.
- Group related constants: `AUTH_COOKIES = { ACCESS_TOKEN: '...', ... } as const`.

---

## Controllers

### Default-Protected Endpoints

JWT guard is registered globally via `APP_GUARD`. Every endpoint is protected by default. Public endpoints opt out with `@Public()`. Do not invert the convention.

### REST Compliance

- Correct HTTP method decorator matching operation semantics.
- Correct status code: `@HttpCode(201)` for POST, `@HttpCode(204)` for DELETE with no body.
- Plural nouns in `@Controller('resources')`. Nest sub-resources: `@Controller('channels/:channelId/videos')`.

### OpenAPI Documentation

Every controller must be documented with `@nestjs/swagger` decorators:

- Class level: `@ApiTags('resource')`.
- Method level: `@ApiOperation({ summary, description })`, `@ApiResponse` for success + each predictable error status.
- Error responses reference `ApiErrorEnvelope` via `getSchemaPath(ApiErrorEnvelope)`.
- Protected handlers include `@ApiBearerAuth('access-token')`. Public ones do NOT.
- Canonical example: `nestjs-project/src/auth/auth.controller.ts`.

### Error Handling

- Controllers should NOT contain `try/catch`. Let exceptions propagate to exception filters.
- Services throw domain exceptions — never NestJS HTTP exceptions from services.
- Never return manually crafted error objects — always throw.

---

## Services

### Never Swallow Errors

`catch` blocks must always end with a `throw` (original or more specific). Exceptions:
- Converting an error to a valid domain result (e.g., `findOneBy` returning null is not an error).
- Background tasks / event handlers / cron jobs: catch-and-log is acceptable (rethrowing would crash the process).

### Domain Exceptions Only

Throw custom `Error` subclasses — never NestJS HTTP exceptions (`NotFoundException`, etc.) from services. Exception filters map domain exceptions to HTTP responses.

---

## Layer Separation

- **Services** own business logic exclusively.
- **Controllers** are thin: receive request, call service(s), return response. Simple request-level decisions OK — domain rules are not.
- **Guards, Interceptors, Pipes, Filters** handle infrastructure concerns only. When they need a business decision, inject a Service.

---

## Modules

- `@Module()` property order: `imports` → `controllers` → `providers` → `exports`.
- `TypeOrmModule.forFeature([...])` goes in domain module imports, never in AppModule.
- Every entity must be registered in `TypeOrmModule.forFeature([Entity])` of its owning module.
- `AppModule` only contains global infrastructure and domain modules — no business providers.
- `exports` only for dependencies other modules need. When a module exposes shared infrastructure, it must export them — and consumer test modules must include the same registration.

---

## Entities

- Always pass explicit table name: `@Entity('table_name')`.
- UUID primary key: `@PrimaryGeneratedColumn('uuid')`.
- Always include `@CreateDateColumn()` and `@UpdateDateColumn()`.
- Sensitive fields: `{ select: false }`. Unique fields: `{ unique: true }`.
- Define both sides of relationships. Prefer explicit relation loading.
- Never modify an entity without creating a corresponding migration.

---

## DTOs

### Validation

- `class-validator` decorators on every field. `class-transformer` when type coercion is needed.

### OpenAPI

- **Request DTOs:** rely on Swagger CLI plugin (configured with `classValidatorShim: true`, `introspectComments: true`). Do NOT add `@ApiProperty` manually — use JSDoc for description/example.
- **Response DTOs:** no class-validator, so every field needs `@ApiProperty`. Canonical: `nestjs-project/src/common/openapi/api-error-envelope.dto.ts`.
- **Union/polymorphic types:** use `@ApiProperty({ oneOf: [...] })`.

### Separation

- Separate DTOs per operation: `CreateXDto`, `UpdateXDto`, `QueryXDto`.
- Never use an entity as a DTO. For updates: `PartialType(CreateXDto)`.

---

## Testing

### Unit Tests (`*.spec.ts`)

- `Test.createTestingModule()` with mocked dependencies.
- A unit test needing a real DataSource is not a unit test — use `*.integration-spec.ts`.

### Integration Tests (`*.integration-spec.ts`)

- Real database (Docker `db` service). Table cleanup: `dataSource.query('DELETE FROM table_name')` or `repository.clear()`.

### E2E Tests (`*.e2e-spec.ts`)

- `supertest` against the running app. Real test database.
- Reproduce `main.ts` global config in `beforeAll`: pipes, filters, interceptors.

### Key Patterns

- `ConfigModule.forRoot({ isGlobal: true, load: [someConfig] })` for modules using `forRootAsync`.
- Override global guards registered with `useClass` by overriding the storage/state token they depend on (e.g., `ThrottlerStorage`).
- Mock `dataSource.transaction(cb)` by stubbing `transaction` to invoke callback with a mock `EntityManager`.
- Test data: use factories/builders. Clean up after each test. Follow AAA (Arrange-Act-Assert).
