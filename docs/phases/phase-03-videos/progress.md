# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/10 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoints: metadados, streaming e download (GET /videos/:id, /stream, /download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video worker: processamento (ffprobe/thumbnail) + ciclo de status + dead-letter
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Documentação: seção de vídeos coerente com o código
- **Status:** pending
- **Tests:** —
- **Observations:** none
