---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-23T12:22:33-0500"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T18:47:39-0500"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-02T15:08:15-0500"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-02T15:08:15-0500"
  docs/phases/phase-02-auth/context.md: "2026-07-02T15:08:15-0500"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-02T15:08:15-0500"
  .kiro/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-02T15:08:15-0500"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-02T18:49:09-0500"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Intent (verbatim):** "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Depends on:** Fase 01, Fase 02

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Deliverables:** "upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas."

**Out of scope:** Not declared explicitly in the plan for this phase. Inferred deferrals (from neighbor scopes): edição de informações do vídeo (título/descrição/categoria/thumbnail customizada) → Fase 04; visibilidade público/unlisted e fluxo rascunho→publicação → Fase 04; player e página de visualização → Fase 05.

**Affected subprojects:** `nestjs-project/` (backend — pré-cadastro, orquestração de upload, publicação de jobs, worker, URL única, endpoints de streaming/download) + new infra containers introduced this phase (Object Storage S3/MinIO, Message Queue, Video Worker/FFmpeg).

**Deferred subprojects:** `next-frontend/` — no UI/screen capability bullet in Phase 03; upload/playback screens deferred to a later phase (backend + cross-layer contracts only this phase).

**Neighbors (for boundary detection only):**

- **Phase 02 — Cadastro, Login e Gerenciamento de Conta:** fluxo completo de conta (cadastro, confirmação, login, logout, recuperação), com canal criado automaticamente. (Depende de: Fase 01)
- **Phase 04 — Gerenciamento de Vídeos e Canal:** edição das informações do vídeo, fluxo rascunho→publicação, painel de administração e página pública do canal. (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message queue technology for background video processing | decided | A: pg-boss (PostgreSQL-backed queue; no Redis) | pg-boss |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-file (10GB) upload strategy | decided | A: Presigned multipart upload direct-to-storage (S3 multipart) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Object-storage organization & presigned access | decided | A: Single bucket + structured key prefixes keyed by video id | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-04 | phase | Backend | Video processing worker runtime & deployment | decided | A: Standalone NestJS application context in a separate container | NestJS createApplicationContext (existing) + ffmpeg binary in worker image |
| phase-03-videos/TD-05 | phase | Backend | Media tooling — metadata extraction & thumbnail generation | decided | A: Direct ffmpeg/ffprobe via Node child_process (no wrapper) | Node child_process (built-in) + ffmpeg/ffprobe binaries |
| phase-03-videos/TD-06 | phase | Cross-layer | Unique per-video URL identifier | decided | B: Reuse uuid v4 as the public URL id (⚠ diverges from recommended nanoid@^3) | none (no new dependency) |
| phase-03-videos/TD-07 | phase | Cross-layer | Streaming & download delivery (HTTP Range / 206) | decided | A: Presigned GET direct-from-storage with native Range/206 | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-08 | phase | Backend | Video status lifecycle & failure handling | decided | A: Explicit status enum state machine + queue-driven failure handling | pg-boss (retries/backoff/dead-letter via TD-01) |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3], status: decided)

_No ad-hoc decisions docs have `related_phases` containing 3._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Reuses the PostgreSQL already in the stack (no Redis, no new broker), keeping the local `compose.yaml` and production footprint minimal — matching the Postgres-first precedent from Phases 01–02. Built-in retry, exponential backoff, and dead-letter are exactly what the video failure lifecycle (TD-08) needs; `SKIP LOCKED`/`LISTEN-NOTIFY` is more than adequate for low job volume. BullMQ/RabbitMQ features are real but unnecessary and both add infrastructure.
**Libraries:** pg-boss

### phase-03-videos/TD-02

**Recommendation:** Keeps all 10GB off the API (the only option that truly honors "sem impacto"), gives parallel transfer plus part-level resume for flaky connections, and works identically against local MinIO and production S3 via the AWS SDK v3 presigner. tus adds an extra server component; API-proxying is disqualified by the performance requirement. Incomplete multipart uploads reaped via a storage lifecycle rule.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** Single bucket + structured key prefixes keyed by video id is the simplest to provision/secure across MinIO and S3, with deterministic keys and clean prefix-based lifecycle rules (including reaping incomplete multipart uploads from TD-02). Persisting storage **keys** (not full URLs) keeps rows environment-agnostic and lets every access be a freshly-signed, short-lived URL.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-04

**Recommendation:** A standalone NestJS application context in a separate container isolates FFmpeg CPU load from the API (honoring "sem impacto") while reusing the exact same modules, entities, config, and storage client via `createApplicationContext` — no code duplication. The worker image adds the `ffmpeg` binary; the API image stays lean. Matches the architecture diagram's separate-worker container.
**Libraries:** NestJS `NestFactory.createApplicationContext` (existing) + ffmpeg binary in worker image

### phase-03-videos/TD-05

**Recommendation:** The canonical wrapper `fluent-ffmpeg` is archived, npm-flagged "no longer supported", and broken with recent FFmpeg — it must not anchor a new codebase. A thin `spawn` around `ffprobe -print_format json` (metadata/duration) and `ffmpeg -ss … -frames:v 1` (thumbnail) is stable, dependency-free, fully controllable, and needs only the `ffmpeg` binary the worker image already installs.
**Libraries:** Node `child_process` (built-in) + system `ffmpeg`/`ffprobe` binaries

### phase-03-videos/TD-06

**Decision: B — reuse `uuid` v4 as the public URL id.** ⚠ **Diverges from the Recommendation (Option A, `nanoid@^3`) — downstream planning MUST follow Decision B, not the recommendation prose.** Per the TD Note, this is an intentional divergence: reusing the existing `uuid` v4 PK adds zero dependencies and sidesteps the ESM/CommonJS `nanoid` constraint, accepting longer/less-pretty URLs as the trade-off (also a deliberate learning-exercise choice for this phase).
**Recommendation (Option A — NOT the decision):** short, URL-safe, collision-resistant ids via `nanoid`, keeping the internal uuid PK out of public URLs; caveat is pinning to `nanoid@^3` (v4/v5 are ESM-only → `ERR_REQUIRE_ESM` under CommonJS).
**Libraries:** none (Decision B uses the existing `uuid` PK — no new dependency)

### phase-03-videos/TD-07

**Recommendation:** Presigned GET direct-from-storage matches the architecture diagram's "Frontend streams from Object Storage" edge, offloads all streaming/download bandwidth to storage (honoring "sem impacto" and scaling), and gets Range/`206` for free from S3/MinIO. Short-lived, API-issued presigned URLs retain access control (needed for unlisted videos later) without proxying bytes; download reuses the same URL with a content-disposition override. API-proxying disqualified on bandwidth; public CDN premature and breaks unlisted access control.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-08

**Recommendation:** A single `status` enum (`draft → processing → ready | failed`) gives one unambiguous state that is easy to query and maps directly onto pg-boss's retry/backoff/dead-letter machinery (TD-01). An idempotent, `videoId`-keyed handler makes retries safe; terminal (dead-lettered) failures set `failed` with a reason. Boolean flags allow contradictory states; a separate jobs table duplicates pg-boss's own tracking.
**Libraries:** pg-boss (via TD-01)

## Inherited Decisions Detail

_Inherited from prior phases (Recommendation essence + Libraries per decided TD). Correlator-confirmed `openapi-docs-nestjs` is included below (deduped against phases-reader)._

### phase-01-configuracao-base/TD-01
**Recommendation:** `@nestjs/config` — official, NestJS 11-compatible; `registerAs()` factory doubles as a plain-importable function for the TypeORM CLI and as a DI token.
**Libraries:** @nestjs/config

### phase-01-configuracao-base/TD-02
**Recommendation:** Joi — first-class `validationSchema` integration, native string→number coercion; env validated once at startup vs. per-request DTOs.
**Libraries:** joi

### phase-01-configuracao-base/TD-03
**Recommendation:** Namespaced config with `registerAs` — per-domain files, typed injection via `ConfigType<typeof xxxConfig>`, scales as storage/queue configs arrive.
**Libraries:** —

### phase-01-configuracao-base/TD-04
**Recommendation:** Shared `registerAs` factory between app and TypeORM CLI — `data-source.ts` imports the factory, calls `dotenv.config()`, then the factory. Zero duplication.
**Libraries:** dotenv (transitive)

### phase-02-auth/TD-01
**Recommendation:** Argon2id — OWASP-recommended for greenfield 2026; native build is a one-time Docker cost.
**Libraries:** argon2

### phase-02-auth/TD-03
**Recommendation:** Refresh Token Rotation — strongest security with theft detection; PostgreSQL already in stack; short grace period mitigates races.
**Libraries:** —

### phase-02-auth/TD-04
**Recommendation:** Random opaque tokens in DB — revocable, trivial table, decoupled from JWT.
**Libraries:** —

### phase-02-auth/TD-05
**Recommendation:** `@nestjs-modules/mailer` — best NestJS integration, SMTP matching the arch diagram, Mailpit locally, Handlebars templating.
**Libraries:** @nestjs-modules/mailer, handlebars

### phase-02-auth/TD-06
**Recommendation:** class-validator + class-transformer — documented NestJS approach; backend-only project already decorator-heavy.
**Libraries:** class-validator, class-transformer

### phase-02-auth/TD-07
**Recommendation:** Custom Domain Exception Filter — machine-readable domain error codes `{ statusCode, error, message }` the FE can switch on; low cost. (Scope: Cross-layer.)
**Libraries:** —

### phase-02-auth/TD-08
**Recommendation:** `@nestjs/throttler` — native DI/guard integration, module-scoped `APP_GUARD` with `@SkipThrottle()`; in-memory sufficient for a single instance.
**Libraries:** @nestjs/throttler

### phase-02-auth/TD-09
**Recommendation:** Refresh token format = JWT (diverged from opaque) — reuses `@nestjs/jwt` signing/verification for a single token format.
**Libraries:** @nestjs/jwt

### phase-02-auth/TD-10
**Recommendation:** Nickname from email prefix `[a-z0-9_]` + `user_<random>` fallback — simplest/portable for URL handles; fallback guarantees validity.
**Libraries:** —

### openapi-docs-nestjs/TD-01
**Recommendation:** `@nestjs/swagger` — preserves class-validator (phase-02 TD-06) without re-platform; CLI plugin `classValidatorShim: true` infers schemas from existing decorators. **(Correlator-confirmed HIGH — governs the many new Phase 03 backend endpoints.)**
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02
**Recommendation:** Both Swagger UI + committed `openapi.json` — marginal cost is one ~15-line npm script; correct foundation for FE codegen plus interactive UI.
**Libraries:** —

### openapi-docs-nestjs/TD-03
**Recommendation:** Docs exposure dev/staging only (`SWAGGER_ENABLED`) — defensive posture; committed `openapi.json` still consultable; trivial to reopen.
**Libraries:** —

_Frontend-foundation and Phase 02 frontend TDs (next-frontend-*, phase-02-auth-frontend) are inherited-on-record via the prior-phase context but omitted from this backend-phase detail list — no frontend surface is in Phase 03 scope. They remain available when the video UI phase runs._

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` — one file per domain in `src/config/`. _(from phase 01)_
- New env vars added to the Joi schema in `src/config/env.validation.ts` (`allowUnknown: true, abortEarly: false`) AND to `.env.example`. _(from phase 01)_
- Config injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`; same factory importable as a plain function for non-DI contexts (TypeORM CLI). _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; connection params from a single `databaseConfig` factory, never duplicated. _(from phase 01)_
- Standardized error format `{ statusCode, error, message }` via global `DomainExceptionFilter` + `ValidationExceptionFilter`; services throw domain `Error` subclasses of `DomainException` (never NestJS HTTP exceptions); new error codes extend the Error Catalog. _(from phase 02)_
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) reproduced in `main.ts`; E2E reproduces `main.ts` global config in `beforeAll`. _(from phase 02)_
- Global `JwtAuthGuard` via `APP_GUARD` — endpoints protected by default, opt out with `@Public()`; `@CurrentUser()` reads the payload; every signed JWT carries a unique `jti`. _(from phase 02)_
- Entities: explicit `@Entity('table_name')`, `@PrimaryGeneratedColumn('uuid')`, `@CreateDateColumn()`/`@UpdateDateColumn()`, `{ select: false }` for sensitive cols, `{ unique: true }`, both relation sides defined; never modify an entity without a CLI-generated migration; never `synchronize: true`. _(from phase 02)_
- DTOs separate per operation (`CreateXDto`/`UpdateXDto`/`QueryXDto`); request DTOs use the Swagger CLI plugin (JSDoc, no manual `@ApiProperty`); response DTOs annotate each field; controllers documented with `@nestjs/swagger` (`@ApiTags`/`@ApiOperation`/`@ApiResponse`/`@ApiBearerAuth('access-token')`; errors reference `ApiErrorEnvelope` via `getSchemaPath`). _(from phase 02 + openapi-docs-nestjs)_
- Single Responsibility: each entity registered in `TypeOrmModule.forFeature([Entity])` of its owning module; extract a module that starts owning foreign logic/entities. _(from phase 02)_
- Docker networking: use Compose service names as hosts (`db`, `mailpit`, and new `minio`/queue), never `localhost`. _(from phase 01/02)_
- Test suffixes/layers: `*.spec.ts` (unit, mocked deps), `*.integration-spec.ts` (real DB, `--runInBand`, cleanup via `DELETE FROM`/`repository.clear()`), `test/*.e2e-spec.ts` (supertest); non-TS runtime assets shipped to `dist/` registered in `nest-cli.json` `assets`; `forceExit: true` in Jest configs. _(from phase 02)_
- Cross-cutting: strict TypeScript (`npx tsc --noEmit` exits 0), `import type` for type-only imports, ESLint/Prettier; DoD = relevant + full test suite passes, tsc clean, lint passes. _(from phase 01/02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| "Confirmação de conta via e-mail com link de ativação" (FE landing screen) | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up in a future phase. Backend ready. |
| "Logout" (UI) | deferred | phase-02-auth-frontend | Logout button lives in authenticated chrome (Phase 04+). BFF route + upstream already shipped. |
| "Recuperação de senha — set-new-password destination screen" | deferred | phase-02-auth-frontend | Reset-password destination screen absent from Figma; emailed link is a 404 until a later phase delivers the screen. |
| Umbrella "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | signup/login/forgot-password ship; confirmação + set-new-password screens deferred per rows above. |

_Informational only — `plan-validate` does not fire issues based on unaddressed entries here. No backend deferred capabilities enter Phase 03._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration (DB contract) |
| Service with configured lib (JWT, cache, queue) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real capture service (Mailpit) or local adapter (MinIO / pg-boss) |
| Module with configured imports | Unit: compilation test |
| Controller (`*.controller.ts`) | E2E only — do NOT write unit tests |
| DTO (`*.dto.ts`) | E2E: one validation-wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Pipe (custom transform/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Phase-03 note (from testing guide §2 "Worth testing"): explicitly covers service-to-external-system contracts (storage uploads, queue publishing) and race conditions (concurrent video uploads) — relevant to TD-02/03 (upload+storage), TD-01/04/08 (queue+worker+status). "E2E" here = HTTP-layer integration via supertest, not browser tests. Always `afterAll(() => app.close())` to avoid open-handle hangs._

### next-frontend

_Deferred subproject for Phase 03 (no UI surface this phase). Frontend testing requirements apply when the video UI phase runs; see `testing-guide-next-frontend`._
