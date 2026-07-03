---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-02T18:49:59-0500"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-02T18:49:09-0500"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T18:47:39-0500"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-02T15:08:15-0500"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o fluxo de vídeo do StreamTube ponta a ponta no backend — upload de arquivos de até 10GB direto para object storage sem impactar a API, pré-cadastro automático do vídeo como rascunho, processamento assíncrono em fila para extração de metadados e geração de thumbnail, URL única por vídeo e reprodução via streaming (Range/206) e download servidos direto do storage.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços Docker (storage + fila)

**Description:** Instala as dependências de storage/fila, adiciona a configuração namespaced e sobe os novos containers de infraestrutura (MinIO + worker) — base para todos os SIs seguintes.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` e `pg-boss` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-01`).
2. Criar `src/config/storage.config.ts` via `registerAs('storage', ...)` — `endpoint`, `bucket`, `region`, `accessKey`, `secretKey`, `partSize` (per `phase-03-videos/TD-03`), seguindo a convenção de config namespaced herdada da Fase 01.
3. Criar `src/config/queue.config.ts` via `registerAs('queue', ...)` reutilizando os inputs do `databaseConfig` para a connection string do pg-boss (per `phase-03-videos/TD-01`).
4. Estender o schema Joi em `src/config/env.validation.ts` e o `.env.example` com `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` e vars de fila (host = service name `minio`, per convenções Docker).
5. Adicionar os serviços `minio` (+ bootstrap do bucket) e `video-worker` (imagem com binário `ffmpeg`) ao `compose.yaml` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-05`).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe os serviços `minio` e `video-worker` com status `running` além dos serviços existentes.
- O bucket configurado em `S3_BUCKET` existe no MinIO após o bootstrap.
- Boot da API falha na validação Joi quando qualquer variável `S3_*` obrigatória está ausente.

---

### SI-03.2 — Entidade Video + migration

**Description:** Cria a entidade `Video` (com o enum de status) e a migration correspondente, estabelecendo o modelo de dados de vídeo e a relação de posse com `Channel`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` como `@Entity('videos')` com todos os campos do `### Data Model → Video` (id uuid PK/URL pública per `phase-03-videos/TD-06`, `status` enum per `phase-03-videos/TD-08`, `original_key`/`thumbnail_key` per `phase-03-videos/TD-03`, `duration_seconds`/`metadata` per `phase-03-videos/TD-05`, `failure_reason`, `@CreateDateColumn`/`@UpdateDateColumn`).
2. Definir o enum `video_status` (`draft` | `processing` | `ready` | `failed`) e a relação `@ManyToOne(() => Channel)` (com o lado `@OneToMany` em `Channel`), `channel_id` not null, on delete cascade.
3. Gerar a migration via `migration:generate` — cria o tipo enum `video_status`, a tabela `videos`, a FK para `channels` e os índices em `channel_id` e `status`.
4. Registrar `Video` em `TypeOrmModule.forFeature([Video])` dentro do novo `VideosModule` e declarar `VideosModule` no `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: NOT NULL/FK/default `draft`/enum constraints, cascade delete via `Channel` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** SI-03.1 (config/DB wiring disponível para rodar a migration)

**Acceptance criteria:**

- Após `migration:run`, a tabela `videos` existe com o tipo enum `video_status` e a FK para `channels`.
- Inserir um `Video` sem `channel_id` viola a constraint NOT NULL/FK.
- Um `Video` recém-criado sem `status` explícito persiste com `status = 'draft'`.
- Deletar um `Channel` remove em cascata os `videos` associados.

---

### SI-03.3 — StorageService (S3 client + multipart + presigned URLs)

**Description:** Encapsula todo o acesso ao object storage (MinIO/S3): cliente configurado, orquestração do multipart e geração de URLs presigned — bytes nunca transitam pela API.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` instanciando `S3Client` com `forcePathStyle: true` e `endpoint` do `storageConfig` (per `phase-03-videos/TD-03`).
2. Implementar `createMultipartUpload(key)` + `presignPartUrls(key, uploadId, partCount)` com `getSignedUrl` sobre `UploadPartCommand` (per `phase-03-videos/TD-02`).
3. Implementar `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`).
4. Implementar `presignGetUrl(key, { downloadFilename? })` via `getSignedUrl` sobre `GetObjectCommand` (com `ResponseContentDisposition` no modo download) e `putObject`/`deleteObject` para thumbnails (per `phase-03-videos/TD-07`, `phase-03-videos/TD-03`).
5. Criar `StorageModule` exportando `StorageService` e registrá-lo onde consumido.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: contrato real contra MinIO — multipart create→presign→complete e presign GET | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (config + serviço MinIO)

**Acceptance criteria:**

- `createMultipartUpload` retorna um `uploadId` não vazio para uma key nova.
- Uma parte enviada via a URL presigned de `presignPartUrls` é aceita pelo storage e o `completeMultipartUpload` monta o objeto final recuperável por `presignGetUrl`.
- `abortMultipartUpload` remove as partes pendentes (o objeto final não existe).
- A URL de `presignGetUrl` no modo download carrega `response-content-disposition=attachment`.

---

### SI-03.4 — QueueService (integração pg-boss)

**Description:** Integra o pg-boss como fila de processamento: ciclo de vida da instância, declaração das filas (`video-process` + dead-letter) e API de enfileiramento consumida pela API e pelo worker.

**Technical actions:**

1. Criar `src/queue/queue.service.ts` implementando `OnModuleInit`/`OnModuleDestroy` — constrói `PgBoss` com a connection do `queueConfig`, `boss.on('error', ...)`, `boss.start()` e `createQueue('video-process', { retryLimit: 3, retryBackoff: true, retryDelayMax: 600, deadLetter: 'video-process-dlq' })` + `createQueue('video-process-dlq')` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`).
2. Implementar `enqueueVideoProcessing(videoId)` via `boss.send('video-process', { videoId })` com `singletonKey` = videoId para enfileiramento idempotente (per `phase-03-videos/TD-01`).
3. Criar `QueueModule` exportando `QueueService`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueService` | Integration: pg-boss real contra o DB — `start()` bootstrapa o schema `pgboss` e `enqueueVideoProcessing` cria o job | `src/queue/queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (config de fila + DB)

**Acceptance criteria:**

- Após o boot, o schema `pgboss` e as filas `video-process` e `video-process-dlq` existem no banco.
- `enqueueVideoProcessing(videoId)` cria exatamente um job na fila `video-process` com payload `{ videoId }`.
- Chamar `enqueueVideoProcessing` duas vezes para o mesmo `videoId` não cria job duplicado (singletonKey).

---

### SI-03.5 — Endpoint: pré-cadastro + iniciar upload (POST /videos)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-initiate.plan.md`
**Authorization:** Authenticated (torna-se owner)

**Description:** Cria o vídeo como `draft`, inicia o upload multipart e devolve as URLs presigned das partes — o navegador envia os 10GB direto ao storage.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` (`filename`, `contentType`, `size`) com class-validator conforme `### API Contracts → Validation Rules — POST /videos`.
2. Implementar `VideosService.createDraftUpload(user, dto)` — cria a row `draft` com `title` derivado do `filename`, chama `StorageService.createMultipartUpload` + `presignPartUrls`, persiste `upload_id`/`original_key` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-02`, `phase-03-videos/TD-06`).
3. Criar `VideosController` com `POST /videos` (`@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth('access-token')`) retornando `201` com `{ id, uploadId, key, partSize, parts }` conforme `### API Contracts → POST /videos`.
4. Adicionar as domain exceptions `FILE_TOO_LARGE` (400) e `UNSUPPORTED_MEDIA_TYPE` (415) estendendo `DomainException` conforme `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraftUpload` | Unit: branch de `size > 10GB` → `FILE_TOO_LARGE`, `contentType` inválido → `UNSUPPORTED_MEDIA_TYPE`, caminho feliz (mock repo + StorageService) | `src/videos/videos.service.spec.ts` |

_E2E do endpoint são autoradas por `/plan-test-specs` no spec referenciado em **Test Specs**._

**Dependencies:** SI-03.2 (entidade Video), SI-03.3 (StorageService)

**Acceptance criteria:**

- `POST /videos` autenticado com body válido retorna `201` com `id`, `uploadId`, `key` e a lista `parts` de URLs presigned.
- `POST /videos` com `size` acima de 10GB retorna `400` com `error: "FILE_TOO_LARGE"`.
- `POST /videos` com `contentType` fora de `video/*` retorna `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`.
- `POST /videos` sem token de acesso retorna `401`.
- Após sucesso, existe uma row `videos` com `status = 'draft'` pertencente ao canal do usuário autenticado.

---

### SI-03.6 — Endpoint: completar upload + enfileirar processamento (POST /videos/:id/complete)

**Route:** POST /videos/:id/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Finaliza o multipart no storage, transiciona `draft → processing` e enfileira o job de processamento.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts: { partNumber, etag }[]`) conforme `### API Contracts → POST /videos/:id/complete`.
2. Implementar `VideosService.completeUpload(user, id, dto)` — valida posse e estado `draft`, chama `StorageService.completeMultipartUpload`, seta `status = 'processing'`, limpa `upload_id` e chama `QueueService.enqueueVideoProcessing(id)` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, `phase-03-videos/TD-01`).
3. Adicionar o handler `POST /videos/:id/complete` no `VideosController` (swagger completo) retornando `200` com `{ id, status }`.
4. Adicionar as domain exceptions `VIDEO_NOT_FOUND` (404), `VIDEO_NOT_OWNER` (403) e `INVALID_UPLOAD_STATE` (409) conforme `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: não-owner → `VIDEO_NOT_OWNER`, estado ≠ draft → `INVALID_UPLOAD_STATE`, inexistente → `VIDEO_NOT_FOUND`, sucesso enfileira job | `src/videos/videos.service.spec.ts` |

_E2E autoradas por `/plan-test-specs`._

**Dependencies:** SI-03.5 (draft criado), SI-03.4 (QueueService)

**Acceptance criteria:**

- `POST /videos/:id/complete` do owner com `parts` válidas retorna `200` com `status: "processing"`.
- Após sucesso, exatamente um job `video-process` com `{ videoId: id }` é enfileirado.
- `POST /videos/:id/complete` de um usuário não-owner retorna `403` com `error: "VIDEO_NOT_OWNER"`.
- `POST /videos/:id/complete` sobre um vídeo que não está em `draft` retorna `409` com `error: "INVALID_UPLOAD_STATE"`.
- `POST /videos/:id/complete` com `:id` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.7 — Endpoint: abortar upload (POST /videos/:id/abort-upload)

**Route:** POST /videos/:id/abort-upload
**Test Specs:** see `nestjs-project/specs/videos-upload-abort.plan.md`
**Authorization:** Owner

**Description:** Cancela um upload multipart em andamento, libera as partes no storage e remove o rascunho.

**Technical actions:**

1. Implementar `VideosService.abortUpload(user, id)` — valida posse e estado `draft`, chama `StorageService.abortMultipartUpload` e remove a row draft (per `phase-03-videos/TD-02`).
2. Adicionar o handler `POST /videos/:id/abort-upload` no `VideosController` com `@HttpCode(204)` e swagger completo, conforme `### API Contracts → POST /videos/:id/abort-upload`.
3. Reutilizar as domain exceptions `VIDEO_NOT_FOUND` (404), `VIDEO_NOT_OWNER` (403) e `INVALID_UPLOAD_STATE` (409) conforme `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.abortUpload` | Unit: não-owner → `VIDEO_NOT_OWNER`, estado ≠ draft → `INVALID_UPLOAD_STATE`, sucesso aborta no storage e deleta a row | `src/videos/videos.service.spec.ts` |

_E2E autoradas por `/plan-test-specs`._

**Dependencies:** SI-03.5 (draft criado)

**Acceptance criteria:**

- `POST /videos/:id/abort-upload` do owner sobre um draft retorna `204` sem corpo.
- Após sucesso, a row `videos` não existe mais e as partes multipart foram abortadas no storage.
- `POST /videos/:id/abort-upload` de um não-owner retorna `403` com `error: "VIDEO_NOT_OWNER"`.
- `POST /videos/:id/abort-upload` sobre um vídeo que não está em `draft` retorna `409` com `error: "INVALID_UPLOAD_STATE"`.

---

### SI-03.8 — Endpoints: metadados, streaming e download (GET /videos/:id, /stream, /download)

**Route:** GET /videos/:id · GET /videos/:id/stream · GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Public (owner enxerga qualquer status; anônimo/não-owner só `ready`)

**Description:** Expõe a visão de metadados do vídeo e a entrega de bytes por streaming/download via URLs presigned servidas direto do storage (Range/206 nativo).

**Technical actions:**

1. Implementar `VideosService.getVideoView(id, user?)` — aplica a regra de visibilidade (owner vê qualquer status; anônimo/não-owner só `ready`, senão `VIDEO_NOT_FOUND`) e presigna a `thumbnailUrl` quando `ready` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`).
2. Implementar `VideosService.getStreamRedirect(id)` e `getDownloadRedirect(id)` — exigem `status = ready` (senão `VIDEO_NOT_READY`) e retornam a URL presigned GET (download com `ResponseContentDisposition`) (per `phase-03-videos/TD-07`).
3. Adicionar ao `VideosController`: `GET /videos/:id` (`@Public()`, `200`), `GET /videos/:id/stream` e `GET /videos/:id/download` (`@Public()`, `302` via `Location`) com swagger completo, conforme `### API Contracts`.
4. Adicionar a domain exception `VIDEO_NOT_READY` (409) e reutilizar `VIDEO_NOT_FOUND` (404) conforme `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getVideoView` | Unit: anônimo em vídeo não-`ready` → `VIDEO_NOT_FOUND`; owner enxerga `draft`/`processing`/`failed`; `ready` inclui `thumbnailUrl` | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamRedirect`/`getDownloadRedirect` | Unit: `status ≠ ready` → `VIDEO_NOT_READY`; `ready` retorna URL presigned (download com disposition) | `src/videos/videos.service.spec.ts` |

_E2E autoradas por `/plan-test-specs`._

**Dependencies:** SI-03.2 (entidade Video), SI-03.3 (StorageService)

**Acceptance criteria:**

- `GET /videos/:id` de um vídeo `ready` retorna `200` com `status`, `durationSeconds`, `metadata` e `thumbnailUrl` presigned.
- `GET /videos/:id` anônimo de um vídeo não-`ready` retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/:id/stream` de um vídeo `ready` retorna `302` com `Location` apontando para uma URL presigned GET.
- `GET /videos/:id/download` de um vídeo `ready` retorna `302` cuja URL presigned carrega content-disposition `attachment`.
- `GET /videos/:id/stream` de um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`.

---

### SI-03.9 — Video worker: processamento (ffprobe/thumbnail) + ciclo de status + dead-letter

**Description:** Worker standalone que consome a fila, extrai metadados/duração, gera a thumbnail, transiciona o vídeo para `ready` e trata falhas terminais via dead-letter (`failed`).

**Technical actions:**

1. Criar `src/worker/main.ts` — bootstrap via `NestFactory.createApplicationContext(WorkerModule)` reutilizando módulos/config/entidades da API (per `phase-03-videos/TD-04`).
2. Criar `src/worker/video-processing.service.ts` registrando `boss.work('video-process', handler)` — baixa o original do storage, roda `ffprobe -print_format json` (duração + metadata) e `ffmpeg -ss … -frames:v 1` (thumbnail) via `child_process`, faz upload da thumbnail (`thumbnails/{videoId}/thumb.jpg`) e seta `status = 'ready'` com `duration_seconds`/`metadata`/`thumbnail_key` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-03`, `phase-03-videos/TD-08`).
3. Tornar o handler idempotente, keyed por `videoId` (seguro para re-execução em retry) (per `phase-03-videos/TD-08`).
4. Registrar `boss.work('video-process-dlq', handler)` que seta `status = 'failed'` com `failure_reason` no esgotamento dos retries (per `phase-03-videos/TD-08`, `phase-03-videos/TD-01`).
5. Adicionar o binário `ffmpeg`/`ffprobe` à imagem do worker (`Dockerfile`) e registrar o comando de start do worker no `compose.yaml` (per `phase-03-videos/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Integration: job real (pg-boss + MinIO) — original processado seta `ready` com `duration_seconds`/`metadata`/`thumbnail_key` | `src/worker/video-processing.service.integration-spec.ts` |
| `VideoProcessingService` | Unit: handler é idempotente por `videoId`; branch de dead-letter seta `failed` + `failure_reason` | `src/worker/video-processing.service.spec.ts` |

**Dependencies:** SI-03.4 (QueueService/filas), SI-03.3 (StorageService), SI-03.2 (entidade Video)

**Acceptance criteria:**

- Ao processar um job `video-process`, o vídeo passa de `processing` para `ready` com `duration_seconds` e `metadata` preenchidos.
- Após o processamento, existe um objeto de thumbnail em `thumbnails/{videoId}/thumb.jpg` e a row referencia `thumbnail_key`.
- Reprocessar o mesmo `videoId` (retry) não duplica efeitos nem corrompe o estado `ready` (idempotência).
- Um job que esgota os retries roteia para `video-process-dlq` e deixa o vídeo em `failed` com `failure_reason` preenchido.

---

## Technical Specifications

### Data Model

#### Video

New entity `@Entity('videos')` owned by a new `VideosModule` (registered in `AppModule` via `TypeOrmModule.forFeature([Video])`). The `id` is the uuid v4 primary key **and** the public URL identifier (TD-06 Decision B — reuse the uuid PK, no separate `nanoid` column). Storage **keys** are persisted, never full URLs (TD-03) — every access is a freshly-signed short-lived URL.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`@PrimaryGeneratedColumn('uuid')`) — also the public URL id (TD-06) |
| channel_id | uuid | FK → `channels.id`, not null, on delete cascade (ownership; inherited `channels` entity from Fase 02) |
| title | varchar(255) | not null (draft pre-register — derived from filename at upload start) |
| status | enum `video_status` | not null, default `'draft'` — one of `draft` \| `processing` \| `ready` \| `failed` (TD-08 state machine) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId` held while the upload is in progress (TD-02); cleared after complete/abort |
| original_key | varchar(512) | nullable — object key of the uploaded original, `videos/{id}/original.<ext>` (TD-03) |
| thumbnail_key | varchar(512) | nullable — object key of the generated thumbnail, `thumbnails/{id}/thumb.jpg` (TD-03/05) |
| content_type | varchar(127) | nullable — MIME type of the original file |
| size_bytes | bigint | nullable — original file size in bytes (≤ 10GB) |
| duration_seconds | integer | nullable — duration extracted by ffprobe (TD-05) |
| metadata | jsonb | nullable — ffprobe-extracted metadata (width, height, codec, bitrate, container) (TD-05) |
| failure_reason | text | nullable — human-readable reason set on terminal (dead-lettered) failure (TD-08) |
| created_at | timestamptz | `@CreateDateColumn()`, default now() |
| updated_at | timestamptz | `@UpdateDateColumn()`, default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one, `channel_id`). Both sides defined per entity conventions.
**Indexes:** index on `channel_id` (list videos of a channel); index on `status` (worker/DLQ queries and public filtering).
**Migration:** CLI-generated (`migration:generate`) — creates the `video_status` enum type + `videos` table + FK + indexes. `synchronize: false` (inherited convention); pg-boss's own `pgboss` schema is bootstrapped by the library at startup and is **not** modeled as a TypeORM entity/migration (TD-01).

### API Contracts

Backend tier (Scope-driven — TD-02/06/07/08). All endpoints under `@Controller('videos')`, documented with `@nestjs/swagger` (`@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth('access-token')` on protected handlers; errors reference `ApiErrorEnvelope` via `getSchemaPath`). Byte transfer never passes through the API — the browser PUTs/GETs directly against object storage via presigned URLs (TD-02/07).

#### POST /videos (SI-03.5)

Pre-registers the video as a `draft` and initiates the S3 multipart upload (TD-02/08). Returns the video id (public URL id, TD-06), the multipart `uploadId`, the storage `key`, and one presigned PUT URL per part (part size fixed server-side; parts sized from `size`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access token}

**Request body:**
- filename: string, required — original file name (used to derive `title` and extension)
- contentType: string, required — MIME type, must match `video/*`
- size: number, required — total file size in bytes (1 … 10737418240)

**Response 201:**
- id: string (uuid) — the video id / public URL id
- uploadId: string — S3 multipart UploadId
- key: string — object key `videos/{id}/original.<ext>`
- partSize: number — byte size of each part (last part may be smaller)
- parts: array of `{ partNumber: number, url: string }` — presigned PUT URLs (short-lived)

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 400 FILE_TOO_LARGE: when `size` exceeds 10GB
- 415 UNSUPPORTED_MEDIA_TYPE: when `contentType` is not `video/*`

---

#### POST /videos/:id/complete (SI-03.6)

Completes the multipart upload (assembles parts on storage), transitions `draft → processing`, and enqueues the `video-process` job (TD-01/02/08). Owner-only.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access token}

**Request body:**
- parts: array of `{ partNumber: number, etag: string }`, required — the ETag returned by storage for each uploaded part

**Response 200:**
- id: string (uuid)
- status: string — `processing`

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 401 (unauthenticated): when no valid access token is presented
- 403 VIDEO_NOT_OWNER: when the video does not belong to the caller's channel
- 404 VIDEO_NOT_FOUND: when no video matches `:id`
- 409 INVALID_UPLOAD_STATE: when the video is not in an uploadable (`draft`) state

---

#### POST /videos/:id/abort-upload (SI-03.7)

Aborts an in-progress multipart upload (releases the parts on storage) and deletes the draft (TD-02). Owner-only. Incomplete uploads left behind are also reaped by a bucket lifecycle rule (AbortIncompleteMultipartUpload) as a backstop.

**Request headers:**
- Authorization: Bearer {access token}

**Response 204:** No content.

**Error responses:**
- 401 (unauthenticated): when no valid access token is presented
- 403 VIDEO_NOT_OWNER: when the video does not belong to the caller's channel
- 404 VIDEO_NOT_FOUND: when no video matches `:id`
- 409 INVALID_UPLOAD_STATE: when the video is not in a `draft` (upload-in-progress) state

---

#### GET /videos/:id (SI-03.8)

Returns the video's current metadata and processing status. Anonymous callers see a video only when `status = ready`; the owner sees the video in any status (draft/processing/ready/failed).

**Request headers:**
- Authorization: Bearer {access token} — optional (public endpoint; owner gets non-ready visibility)

**Response 200:**
- id: string (uuid)
- title: string
- status: string — `draft` | `processing` | `ready` | `failed`
- durationSeconds: number | null
- metadata: object | null — width/height/codec/bitrate/container
- thumbnailUrl: string | null — short-lived presigned GET URL for the thumbnail (null until `ready`)
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `:id`, or when the caller is anonymous/non-owner and the video is not `ready`

---

#### GET /videos/:id/stream (SI-03.8)

Issues a short-lived presigned GET URL and `302`-redirects to it; the browser then streams directly from storage, which serves HTTP `Range` / `206 Partial Content` natively (TD-07). Public.

**Response 302:** `Location` header set to the presigned GET URL (native Range/206 served by storage).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `:id`
- 409 VIDEO_NOT_READY: when the video exists but `status != ready`

---

#### GET /videos/:id/download (SI-03.8)

Same as streaming, but the presigned GET URL sets `ResponseContentDisposition: attachment; filename="..."` so the browser downloads instead of streaming inline (TD-07). Public.

**Response 302:** `Location` header set to the presigned GET URL (with attachment content-disposition).

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `:id`
- 409 VIDEO_NOT_READY: when the video exists but `status != ready`

---

#### Validation Rules — POST /videos request body

- `filename`: required, non-empty string
- `contentType`: required, string matching `video/*` (else `415 UNSUPPORTED_MEDIA_TYPE`)
- `size`: required, integer, `1 … 10737418240` (10GB) (else `400 FILE_TOO_LARGE`)
- `parts[].partNumber` (complete): required, integer ≥ 1
- `parts[].etag` (complete): required, non-empty string

### Authorization Matrix

Global `JwtAuthGuard` (`APP_GUARD`, inherited from Fase 02) protects by default; public endpoints opt out with `@Public()`. "Owner" = the video's `channel_id` belongs to the authenticated user's channel. Anonymous access to `ready` videos supports the "assistir livremente" product rule; unlisted/visibility gating arrives in a later phase.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ | ✓ (becomes owner) |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| POST /videos/:id/abort-upload | ✗ | ✗ | ✓ |
| GET /videos/:id | ✓ (only `ready`) | ✓ (only `ready`) | ✓ (any status) |
| GET /videos/:id/stream | ✓ (only `ready`) | ✓ (only `ready`) | ✓ (only `ready`) |
| GET /videos/:id/download | ✓ (only `ready`) | ✓ (only `ready`) | ✓ (only `ready`) |

### Error Catalog

Domain exceptions extend the inherited `DomainException` base and are mapped to the standardized `{ statusCode, error, message }` envelope by the global `DomainExceptionFilter` (inherited from Fase 02 / TD-07 — no new error format defined this phase). Services throw these domain errors; never NestJS HTTP exceptions.

| error | HTTP | Trigger |
|-------|------|---------|
| VIDEO_NOT_FOUND | 404 | `:id` matches no video, or an anonymous/non-owner caller requests a non-`ready` video |
| VIDEO_NOT_OWNER | 403 | Authenticated caller acts on a video whose `channel_id` is not their channel (complete/abort) |
| INVALID_UPLOAD_STATE | 409 | `complete`/`abort-upload` called on a video not in `draft` (upload-in-progress) state |
| VIDEO_NOT_READY | 409 | `stream`/`download` requested for a video whose `status != ready` |
| FILE_TOO_LARGE | 400 | `POST /videos` with `size` greater than 10GB (10737418240 bytes) |
| UNSUPPORTED_MEDIA_TYPE | 415 | `POST /videos` with `contentType` not matching `video/*` |

_Processing failures are not HTTP errors — a job that exhausts pg-boss retries is dead-lettered and sets the video `status = failed` with `failure_reason` (see Events/Messages + TD-08)._

### Events/Messages

Background processing runs over pg-boss (PostgreSQL-backed queue — no Redis; TD-01). A single `PgBoss` instance is constructed against the same database (Docker service `db`) by both the API (producer) and the standalone worker (consumer, TD-04); pg-boss bootstraps its own `pgboss` schema at `start()`. Queues are declared idempotently at boot. Payloads stay minimal (`{ videoId }`) — the worker loads the row (TD-01/08).

#### video-process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (API) — enqueues via `boss.send('video-process', { videoId }, { retryLimit: 3, retryDelay: 30, retryBackoff: true, retryDelayMax: 600 })` after `POST /videos/:id/complete` assembles the multipart upload (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`).
**Consumer:** `VideoProcessingWorker` (standalone NestJS application context, separate container, per `phase-03-videos/TD-04`) — `boss.work('video-process', handler)`. The handler: downloads/streams the original from storage, runs `ffprobe -print_format json` for duration + metadata and `ffmpeg -ss … -frames:v 1` for the thumbnail (Node `child_process`, per `phase-03-videos/TD-05`), uploads the thumbnail (`thumbnails/{videoId}/thumb.jpg`, TD-03), then sets `status = ready` with `duration_seconds` / `metadata` / `thumbnail_key`.
**Trigger:** upload completed (`draft → processing`) — one job per video.
**Delivery semantics:** at-least-once (pg-boss polling + `LISTEN/NOTIFY` wake-ups). The handler is **idempotent, keyed by `videoId`** (safe to re-run on retry) per `phase-03-videos/TD-08`. Throwing from the handler fails the job → pg-boss retries per `retryLimit`/`retryBackoff`.

---

#### video-process-dlq (dead-letter)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** pg-boss — routes here automatically after `video-process` exhausts all retries (`deadLetter: 'video-process-dlq'` configured on `createQueue`, per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`).
**Consumer:** `VideoProcessingWorker` DLQ listener — `boss.work('video-process-dlq', handler)`; sets the video to the terminal `status = failed` with a `failure_reason` (per `phase-03-videos/TD-08`).
**Trigger:** all retries of `video-process` for a given `videoId` exhausted.
**Delivery semantics:** at-least-once; terminal state — no further retries (per `phase-03-videos/TD-08`).

---

## Dependency Map

| SI | Depende de | Motivo da dependência |
|----|------------|-----------------------|
| SI-03.1 | — (root) | Infra base — deps, config e containers MinIO + worker para todos os SIs seguintes |
| SI-03.2 | SI-03.1 | config/DB disponível para rodar a migration |
| SI-03.3 | SI-03.1 | config + serviço MinIO |
| SI-03.4 | SI-03.1 | config de fila + DB |
| SI-03.5 | SI-03.2, SI-03.3 | entidade + StorageService antes do endpoint de upload |
| SI-03.6 | SI-03.5, SI-03.4 | draft criado + QueueService para completar/enfileirar |
| SI-03.7 | SI-03.5 | draft criado antes de abortar |
| SI-03.8 | SI-03.2, SI-03.3 | entidade + StorageService para metadados/streaming/download |
| SI-03.9 | SI-03.4, SI-03.3, SI-03.2 | fila + storage + entidade para o worker |

**Ordem de execução (waves):** SI-03.1 → { SI-03.2, SI-03.3, SI-03.4 } → SI-03.5 → { SI-03.6, SI-03.7 }. SI-03.8 e SI-03.9 podem entrar assim que suas dependências (SI-03.2/03.3 e SI-03.2/03.3/03.4, respectivamente) estiverem prontas.

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços Docker (storage + fila)
- [ ] SI-03.2 — Entidade Video + migration
- [ ] SI-03.3 — StorageService (S3 client + multipart + presigned URLs)
- [ ] SI-03.4 — QueueService (integração pg-boss)
- [ ] SI-03.5 — Endpoint: pré-cadastro + iniciar upload (POST /videos)
- [ ] SI-03.6 — Endpoint: completar upload + enfileirar processamento (POST /videos/:id/complete)
- [ ] SI-03.7 — Endpoint: abortar upload (POST /videos/:id/abort-upload)
- [ ] SI-03.8 — Endpoints: metadados, streaming e download (GET /videos/:id, /stream, /download)
- [ ] SI-03.9 — Video worker: processamento (ffprobe/thumbnail) + ciclo de status + dead-letter

**Full test suites:**

- [ ] Backend unit + integration passam (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Backend E2E passam (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)

