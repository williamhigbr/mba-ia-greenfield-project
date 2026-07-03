# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/10 completed

### SI-03.1 — Infra: dependências, configuração e serviços Docker (storage + fila)
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - MinIO host ports remapped to `9010:9000` / `9011:9001` — host port 9000 is occupied by a non-podman host process. In-cluster access (API/worker/tests) is via the Compose network `minio:9000`, unaffected.
  - AbortIncompleteMultipartUpload lifecycle backstop omitted from `minio-setup`: this MinIO/mc build rejects an abort-only lifecycle rule (`mc ilm rule add` has no flag; `mc ilm import` fails schema validation regardless of Filter shape). Primary cleanup is the code-level `abortMultipartUpload` in SI-03.7. Re-adding the lifecycle rule is a future enhancement.
  - `video-worker` service runs a placeholder `tail -f /dev/null` command; the real worker start command is wired in SI-03.9.
  - podman-compose emits a harmless `python-dotenv could not parse` warning on the `MAIL_FROM` line; cosmetic to podman's parser, does not affect the Node app.

### SI-03.2 — Entidade Video + migration
- **Status:** completed
- **Tests:** 7 passing (video.entity.integration-spec.ts)
- **Observations:**
  - Dev DB was empty at session start; applied the two inherited migrations (`migration:run`) to establish the baseline before generating the videos migration, so the generated diff is videos-only.
  - Enum type name pinned to `video_status` via `enumName` on the column (TypeORM default would have been `videos_status_enum`) to match the plan's Data Model.
  - `size_bytes` is `bigint` → surfaces as `string` in JS (pg driver); consumers must account for this.
  - `migrations.integration-spec.ts` registers an explicit 2-migration list, so it does not pick up the videos migration; watch full-suite ordering at final verification (that spec drops `channels` CASCADE, which drops the videos→channels FK).

### SI-03.3 — StorageService (S3 client + multipart + presigned URLs)
- **Status:** completed
- **Tests:** 5 passing (storage.service.integration-spec.ts, real MinIO)
- **Observations:**
  - `StorageService` has no original-download method yet; the worker (SI-03.9) needs to fetch the original for ffprobe/ffmpeg — a `getObject`/download helper will be added there.
  - Integration test uploads/downloads parts via Node global `fetch` against the presigned URLs, proving bytes bypass the API entirely.

### SI-03.4 — QueueService (integração pg-boss)
- **Status:** completed
- **Tests:** 3 passing (queue.service.integration-spec.ts, real pg-boss)
- **Observations:**
  - `singletonKey` alone does NOT deduplicate on a `standard`-policy queue in pg-boss v10 — the `video-process` queue is created with `policy: 'stately'` (unique index on `(name, state, singleton_key)` for states ≤ active), which is what makes a duplicate enqueue return null.
  - `retryDelayMax` (from the plan/library-refs) is NOT supported by pg-boss 10.4.2 `RetryOptions` — context7 described a newer version. Dropped `retryDelayMax: 600`; kept `retryLimit`/`retryDelay`/`retryBackoff`. Flag for reconciliation if pg-boss is upgraded.
  - `createQueue` does not alter an existing queue's policy — re-bootstrapping requires dropping the `pgboss` schema (done in tests when policy changes).
  - `QueueModule` is not yet imported into `AppModule`; the producer (SI-03.6) and worker (SI-03.9) import it where needed.

### SI-03.5 — Endpoint: pré-cadastro + iniciar upload (POST /videos)
- **Status:** completed
- **Tests:** unit 4 passing (videos.service.spec.ts) + E2E 5 passing (videos-upload-initiate.e2e-spec.ts)
- **Observations:**
  - `size` upper bound (10GB) and the `video/*` check are enforced in the service as domain exceptions (FILE_TOO_LARGE 400 / UNSUPPORTED_MEDIA_TYPE 415), NOT in the DTO — a DTO `@Max`/`@Matches` would surface a generic VALIDATION_ERROR instead of the spec-required error codes.
  - The uuid PK is pre-generated (`randomUUID`) before insert so the storage key can embed the id (TD-06 Decision B — no nanoid).
  - Added `ChannelsService.findByUserId` for owner resolution.
  - **Lint (per your directive — Phase-03 files only):** the repo lint baseline is already red (~188 errors from Phase 01/02 mock-heavy specs under `recommendedTypeChecked`). All new Phase-03 files are lint-clean. To achieve that I installed `@types/pg@^8` (pg shipped no types), typed all supertest `res.body` accesses, used `app.get(MailService)` instead of reaching into `AuthService` internals, and avoided `expect.any()`-in-object-literal / untyped `mock.calls`. `channels.service.ts` still carries 6 pre-existing errors (its Phase-02 `as any` block) — deferred to your separate lint cleanup.

### SI-03.6 — Endpoint: completar upload + enfileirar processamento (POST /videos/:id/complete)
- **Status:** completed
- **Tests:** unit 8 passing (videos.service.spec.ts: 4 create + 4 complete) + E2E 5 passing (videos-upload-complete.e2e-spec.ts)
- **Observations:**
  - Ownership/state checks factored into a private `loadOwnedVideo` helper (VIDEO_NOT_FOUND → VIDEO_NOT_OWNER order), which SI-03.7 (abort) will reuse.
  - **Side effect:** `VideosModule` now imports `QueueModule`, so `AppModule → VideosModule → QueueModule` means `QueueService.onModuleInit` (pg-boss `start()` + `createQueue`) runs on every app boot, including all E2E suites; `boss.stop()` on `app.close()`. The initiate E2E was re-run and still passes.
  - The complete E2E uses the real flow (POST /videos → PUT a real part to the presigned URL via `fetch` → capture the real ETag → complete) so MinIO's `completeMultipartUpload` receives valid ETags. Job enqueue asserted via `dataSource.query` on `pgboss.job`.
  - E2E `beforeEach` clears `pgboss.job` in addition to videos/channels/users and throttler storage.

### SI-03.7 — Endpoint: abortar upload (POST /videos/:id/abort-upload)
- **Status:** completed
- **Tests:** unit 11 passing (videos.service.spec.ts: 4 create + 4 complete + 3 abort) + E2E 4 passing (videos-upload-abort.e2e-spec.ts)
- **Observations:**
  - `abortUpload` reuses the `loadOwnedVideo` helper (VIDEO_NOT_FOUND → VIDEO_NOT_OWNER), then guards `status === draft` (else INVALID_UPLOAD_STATE), calls `storage.abortMultipartUpload(original_key, upload_id)` and `videoRepository.remove(video)`.
  - Controller handler `POST :id/abort-upload` uses `@HttpCode(204)` (no body); swagger documents 204/401/403/404/409.
  - E2E `createDraft` helper does not upload any part — draft creation already initiates a real multipart upload (real UploadId), which is what abort releases. `createProcessingVideo` drives a draft to `processing` for the non-draft-state case (1.3).

### SI-03.8 — Endpoints: metadados, streaming e download (GET /videos/:id, /stream, /download)
- **Status:** completed
- **Tests:** unit 19 passing (videos.service.spec.ts: +4 getVideoView +4 stream/download) + E2E 5 passing (videos-playback.e2e-spec.ts)
- **Observations:**
  - **Optional auth on a public route:** the global `JwtAuthGuard` short-circuits on `@Public()` and never populates `request.user`. Created `src/auth/guards/optional-jwt-auth.guard.ts` (`OptionalJwtAuthGuard`) — verifies the bearer token if present, sets `request.user`, and treats a missing/invalid token as anonymous (always returns `true`). Applied to `GET /videos/:id` via `@Public() @UseGuards(OptionalJwtAuthGuard)` so the owner sees non-`ready` videos while anonymous callers only see `ready`. Guard registered in `AuthModule` providers+exports; `VideosModule` now imports `AuthModule` (which exports `JwtModule`) so the guard's `JwtService` dep resolves.
  - `getVideoView(id, user?)` → visibility rule + presigned `thumbnailUrl` (only when `ready` and `thumbnail_key` set). Returns `VideoView` (id/title/status/durationSeconds/metadata/thumbnailUrl/createdAt).
  - `getStreamRedirect`/`getDownloadRedirect` share a private `loadReadyVideo` (VIDEO_NOT_FOUND → VIDEO_NOT_READY), then `presignGetUrl(original_key)` (download adds `downloadFilename` → `attachment` disposition). Controller uses `@Redirect()` returning `{ url, statusCode: 302 }` for dynamic redirect.
  - Added `VideoNotReadyException` (409) to domain.exception.ts.
  - E2E `createVideo` helper POSTs a draft (resolves channel + original_key) then load-mutate-saves the row to the target state — no real processing needed. NOTE: had to use load+`save` instead of `repository.update(...)` because TypeORM's `_QueryDeepPartialEntity` rejects a `Partial<Video>` whose `metadata` is `Record<string, unknown>` (jsonb) — tsc error TS2345.
  - E2E asserts presigned URL via `X-Amz-Signature` (stream) and `response-content-disposition=attachment` (download); supertest does not follow redirects by default so `res.headers.location` is inspectable.

### SI-03.9 — Video worker: processamento (ffprobe/thumbnail) + ciclo de status + dead-letter
- **Status:** completed
- **Tests:** unit 5 passing (src/worker/video-processing.service.spec.ts) + integration 1 passing (src/worker/video-processing.service.integration-spec.ts — real pg-boss + MinIO + ffmpeg, end-to-end job)
- **Observations:**
  - Created `src/worker/main.ts` (bootstrap `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks`), `src/worker/worker.module.ts` (lean: ConfigModule.forRoot + TypeOrm.forRootAsync[autoLoadEntities] + `forFeature([Video, Channel, User])` for the relation graph + StorageModule + QueueModule; providers VideoProcessingService + MediaProcessorService), `src/worker/media-processor.service.ts` (injectable `spawn` wrapper: `ffprobe -print_format json -show_format -show_streams` → duration+metadata{width,height,codec,bitRate,container}; `ffmpeg -ss <t> -frames:v 1 -q:v 2` → thumbnail), `src/worker/video-processing.service.ts` (registers `boss.work(VIDEO_PROCESS_QUEUE)` + `boss.work(VIDEO_PROCESS_DLQ)` in onModuleInit; `processVideo(videoId)`: load→skip if already ready (idempotent) / warn if missing / throw if no original_key; mkdtemp→downloadToFile→probe→extractThumbnail(at min(1,dur/2))→putObject(thumbnailKey,'image/jpeg')→save status=ready+duration+metadata+thumbnail_key+failure_reason=null; finally rm workdir; `markFailed(videoId, reason?)`: DLQ handler sets status=failed+failure_reason).
  - Added `StorageService.downloadToFile(key, destPath)` — streams GetObject Body (Readable) to a file via `stream/promises pipeline` (avoids buffering multi-GB in memory).
  - Wired worker start: `package.json` scripts `start:worker`/`start:worker:dev`/`start:worker:prod` (`nest start --entryFile worker/main`); `Dockerfile.worker` CMD → `npm run start:worker:dev`; `compose.yaml` video-worker `command: npm run start:worker:dev`.
  - **ffmpeg location gotcha:** ffmpeg/ffprobe live only in the worker image, NOT in the API image. Since the Deliverables full suite runs `npm test` in the **api** container, added `ffmpeg` to `Dockerfile.dev` (api dev image) and **rebuilt** the api image — verified the worker integration spec now passes in BOTH the worker and api containers. (If the api image is ever rebuilt fresh, it will include ffmpeg via the Dockerfile.)
  - Module init order guarantee: `QueueModule` is imported by `WorkerModule`, so `QueueService.onModuleInit` (boss.start + createQueue) runs before `VideoProcessingService.onModuleInit` (boss.work) — no race.
  - Test fixture: generated a tiny 11KB 2s h264 320×240 `test/fixtures/sample.mp4` via the worker's ffmpeg (`testsrc` lavfi). Integration test seeds user+channel+video(processing), uploads the sample to MinIO at original_key, enqueues, then polls the DB until `ready` (45s deadline); asserts duration>0, metadata{width:320,height:240,codec:'h264'}, thumbnail_key + thumbnail object retrievable. Cleanup uses `TRUNCATE TABLE "users" CASCADE` (users has FK dependents refresh_tokens/verification_tokens — ordered DELETE failed).
  - No competing consumer during tests: the running compose `video-worker` container still runs the old placeholder (`tail -f`), so only the test's own context consumes.

### SI-03.10 — Documentação: seção de vídeos coerente com o código
- **Status:** pending
- **Tests:** —
- **Observations:** none

### Final Verification (DoD) — full-suite run
- **Date:** 2026-07-03
- **Result:** suíte verde ✅ · `tsc --noEmit` exit 0 ✅ · `npm run lint` ❌ (dívida pré-existente das fases 01/02, ver abaixo)
- **Two Phase-03 regressions surfaced only under the full suite (predicted in SI-03.2) and were fixed:**
  1. **`Entity metadata for Channel#videos was not found` (161 occurrences, 11 suites).** The new inverse relation `Channel.videos → Video` (SI-03.2/03.8) requires `Video` to be present in every hand-picked entity list. The real app is unaffected (AppModule autoloads all entities), but isolated test `DataSource`/`TestingModule` setups that registered `Channel` without `Video` failed to build metadata. **Fix:** added `Video` (import + entity-array entry) to the 11 specs that registered `Channel`: `auth/auth.module.spec.ts`, `auth/auth.service.integration-spec.ts`, `auth/entities/refresh-token.entity.integration-spec.ts`, `auth/entities/verification-token.entity.integration-spec.ts`, `channels/channels.module.spec.ts`, `channels/channels.service.integration-spec.ts`, `channels/entities/channel.entity.integration-spec.ts`, `database/migrations.integration-spec.ts` (metadata-only — `synchronize:false`, videos table not created there), `users/users.module.spec.ts`, `users/users.service.integration-spec.ts`, `users/entities/user.entity.integration-spec.ts`. The pattern already existed in `videos/entities/video.entity.integration-spec.ts` (which had `Video` in its list); the earlier SIs simply missed propagating it. Keeps the "define both sides of relationships" convention.
  2. **`env.validation.integration-spec.ts` — `S3_* is required`.** SI-03.1 made `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY` required in the Joi schema, breaking the pre-existing `validate({})` "no error" assertions (SWAGGER_ENABLED defaults). **Fix:** added those four S3 vars to the test's `requiredEnv` baseline.
- **E2E must run `--runInBand`.** `npm run test:e2e` (parallel) fails with DB-contention errors (duplicate keys / FK violations across users/channels/refresh_tokens/videos) because all e2e suites share the one test DB. `npm run test:e2e -- --runInBand` → 7 suites / 71 tests pass. This matches the README ("integração/e2e rodam com `--runInBand`"); `test/jest-e2e.json` does not pin `maxWorkers:1`.
- **Final counts:** unit+integration `29 suites / 184 tests` pass; e2e `7 suites / 71 tests` pass; `tsc --noEmit` exit 0.
- **Lint (`npm run lint`) still red — pre-existing debt, NOT Phase-03.** `150 errors / 40 warnings` across 10 phase-01/02 files (`no-unsafe-*`, `require-await` in mock-heavy specs + `auth.e2e-spec.ts`). Evidence: every offending file was last committed before Phase 03 (except `channels.service.ts`, whose 6 errors are at pre-existing lines 12–16 — the Phase-03 `findByUserId` addition at lines 59–69 is clean); lint count is identical before and after the fixes above (my edits added zero errors); no Phase-03 source file appears in the list. Deferred to a separate lint-cleanup task per AGENTS.md Scope Limits.
