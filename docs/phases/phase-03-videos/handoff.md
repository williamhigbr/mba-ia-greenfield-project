# Phase 03 — Implementation Handoff

Briefing for the agent implementing `docs/phases/phase-03-videos/phase-03-videos.md`.
Grouped by what's most likely to trip up a fresh-context agent.

## Entry point

- Run `/implement videos`. It reads the plan, executes SI-by-SI in dependency order, and runs the relevant tests after each SI.
- The 4 test specs under `nestjs-project/specs/` are freshly stamped and consumed at `/implement` Step 3a — the agent **authors** the E2E test files at `nestjs-project/test/*.e2e-spec.ts` (supertest). Don't move or re-author the specs.
- **Don't edit the plan before starting** — any plan edit bumps its mtime and re-triggers the spec STALE check (would then need another `/plan-test-specs videos` re-stamp).

## ⚠️ Local environment — use `docker-compose`, not `docker compose`

On this machine the Compose v2 plugin (`docker compose`, space) does **not** work properly. Use the standalone **`docker-compose`** (hyphenated) binary for every Compose command. This overrides the command form shown in `AGENTS.md`/`README.md`.

- Correct: `docker-compose up -d`, `docker-compose exec nestjs-api npm test`, `docker-compose ps`, `docker-compose logs nestjs-api`
- Broken here: `docker compose up -d` (space form)

All `npm`/`npx`/`tsc`/test commands still run **inside the container** (`docker-compose exec nestjs-api ...`) — never on the host (env divergence, `DB_HOST` resolves wrong). Service names as hosts (`db`, `minio`), never `localhost`.

## Evaluation auto-fails — do not break these

- **10GB must never pass through the API.** Upload is presigned S3 multipart direct-to-storage (TD-02). `POST /videos/:id/complete` receives only part **ETags**, never bytes. Proxying the file through Nest is an automatic fail.
- **Real storage + queue + worker in Compose.** SI-03.1 adds `minio` and `video-worker` containers; the queue is pg-boss on the existing `db` service (no dedicated broker — intentional per TD-01, documented in SI-03.1).
- **Git Flow:** stay on `feature/phase-03-videos` (branched from `dev`). Never commit to `main`.
- **DoD before "done":** `docker-compose exec nestjs-api npx tsc --noEmit` exits 0, `npm run lint` passes, and full suite (`npm test -- --runInBand` + `npm run test:e2e`) is green.
- **SI-03.10 must actually run** — the videos doc section (AGENTS.md + README) is a graded artifact, coherent with the final code.

## Project conventions / gotchas (from `.kiro/steering`)

- **Migrations via CLI only**, `synchronize: false`. Test against a fresh DB.
- **pg-boss bootstraps its own `pgboss` schema** at `start()` — do **not** model it as a TypeORM entity/migration.
- **Domain exceptions only in services** — never throw NestJS HTTP exceptions from services. New exceptions (`VIDEO_NOT_FOUND`, `VIDEO_NOT_OWNER`, `INVALID_UPLOAD_STATE`, `VIDEO_NOT_READY`, `FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`) extend the inherited `DomainException`; the global `DomainExceptionFilter` maps them to `{ statusCode, error, message }`.
- **Global `JwtAuthGuard` protects by default** — the GET stream/download/metadata endpoints must be `@Public()`.
- **Swagger:** every controller documented (`@ApiTags`/`@ApiOperation`/`@ApiResponse`/`@ApiBearerAuth`). Request DTOs use the Swagger CLI plugin (JSDoc, no manual `@ApiProperty`); response DTOs annotate each field.
- **TypeORM `where: { field: null }` does NOT emit `IS NULL`** — use `IsNull()` (relevant for status/nullable-column queries).
- **Tests:** `afterAll(() => app.close())` to avoid Jest open-handle hangs; E2E must reproduce `main.ts` global config (ValidationPipe + filters) in `beforeAll`; integration + e2e run `--runInBand`.

## Feature-specific things to get right

- **TD-06 divergence (important):** the public per-video URL id is the **uuid v4 PK reused** — do **not** add `nanoid`. The recommendation prose favors nanoid, but Decision B (uuid) is binding.
- **S3 multipart constraints:** min part size 5MB (except last), max 10,000 parts. `partSize` must be chosen so 10GB fits under 10,000 parts (e.g., ~100MB parts → ~100 parts). MinIO client needs `forcePathStyle: true` + custom `endpoint`. Persist storage **keys**, never full URLs.
- **Worker (SI-03.9):** standalone `NestFactory.createApplicationContext`, separate container, `ffmpeg`/`ffprobe` binary in the worker image. Use raw `child_process` — **do not** use `fluent-ffmpeg` (archived/broken, per TD-05). Handler must be **idempotent keyed by `videoId`**; DLQ handler sets `failed` + `failure_reason`.
- **Incomplete multipart cleanup:** bucket lifecycle rule (`AbortIncompleteMultipartUpload`) as a backstop for abandoned uploads.

## Library docs

- `library-refs.md` already has distilled Context7 surfaces for `pg-boss`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`. `AGENTS.md` still mandates a Context7 lookup before implementing lib-heavy code — use it rather than relying on training data.

## Execution order (waves)

`SI-03.1` → `{ SI-03.2, SI-03.3, SI-03.4 }` → `SI-03.5` → `{ SI-03.6, SI-03.7 }`; `SI-03.8` and `SI-03.9` once their deps are ready; `SI-03.10` (docs) last, after all feature SIs.
