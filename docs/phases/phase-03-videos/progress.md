# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/10 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint: pré-cadastro + iniciar upload (POST /videos)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint: completar upload + enfileirar processamento (POST /videos/:id/complete)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
