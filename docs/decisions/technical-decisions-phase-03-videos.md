---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-02
scope_description: "Upload of large video files without blocking the API, background processing (queue + worker), object-storage organization and presigned access, automatic metadata/thumbnail extraction, unique per-video URL, streaming/download delivery, and the video processing status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary. Owns the video pre-registration endpoint, the presigned-upload handshake, the object-storage client, the queue producer, and a **separate worker process** (same codebase) that consumes jobs and runs FFmpeg/ffprobe. All backend TDs (TD-01, TD-03, TD-04, TD-05, TD-08) and the backend half of the cross-layer TDs (TD-02, TD-06, TD-07) land here.
- `next-frontend/` — cross-layer **contracts only**. TD-02 (upload handshake), TD-06 (unique URL identifier), and TD-07 (streaming/download) define the API↔browser contract the frontend will consume. The actual upload/playback **screens are deferred to a later phase** (Phase 03 lists no UI/screen capability bullet, mirroring the Phase 02 backend→frontend split). No frontend-only open decision exists in this document.

**Infrastructure additions implied by these decisions** (decided within the TDs, not as standalone repo-wide TDs): a **MinIO** service (S3-compatible, local) and a **video-worker** container (Node + `ffmpeg` binary) added to `nestjs-project/compose.yaml`. **No Redis** service is introduced — TD-01 keeps the queue in PostgreSQL.

**Out of scope / deferred to `plan-phase` (Data Model):** the exact `videos` entity columns. These TDs fix only the *strategic* fields (status enum shape, public URL identifier, storage-key vs full-URL persistence); the full column list, indexes, and the video↔channel FK are resolved during planning.

---

## TD-01: Message Queue Technology for Background Video Processing

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) marks the Message Queue as **TBD** — this is the single genuinely-open stack decision of the phase. The API must publish a "process this video" job; a worker must consume it, with at-least-once delivery, retries, and a failure path (feeds TD-08). The current stack is PostgreSQL 17 only; Phases 01–02 deliberately avoided adding Redis (custom JWT guards + refresh tokens in Postgres rather than a Redis session store).

**Options:**

### Option A: pg-boss (PostgreSQL-backed queue)
- Job queue built on PostgreSQL, using `SKIP LOCKED` for concurrency-safe dequeue and `LISTEN/NOTIFY` for low-latency wakeups. Creates a dedicated `pgboss` schema (partitioned `job` table). Ships built-in `retry_limit` / `retry_delay` / `retry_backoff` and a **dead-letter** queue.
- **Pros:** Zero new infrastructure — reuses the PostgreSQL already in the stack and in `compose.yaml`, consistent with the Phase 01–02 "Postgres-only unless justified" theme. Built-in retry/backoff + dead-letter map directly onto the TD-08 failure lifecycle. Jobs are transactional with app data. Low operational surface for the project's low job volume (uploads are infrequent vs. reads).
- **Cons:** Lower theoretical throughput than Redis-based queues (irrelevant at this scale). Adds load to the primary DB (video processing is low-frequency, so negligible). Smaller ecosystem of dashboards than Bull.

### Option B: BullMQ (Redis-backed queue)
- Mature Redis-based queue with rich features (rate limiting, priorities, flows, Bull Board UI) and NestJS first-party support via `@nestjs/bullmq`.
- **Pros:** High throughput, battle-tested, excellent NestJS integration and tooling/dashboards.
- **Cons:** **Requires adding Redis** — a new runtime service in `compose.yaml`, a new ops dependency, and a new failure mode — solely for a low-volume processing queue. Contradicts the established Postgres-only posture. Its advanced features are unneeded at this scale.

### Option C: RabbitMQ (dedicated broker via `@nestjs/microservices`)
- Full-featured AMQP broker; robust routing, acknowledgements, and dead-letter exchanges.
- **Pros:** Purpose-built message broker with strong delivery guarantees and mature DLX semantics.
- **Cons:** Heaviest option — a new broker to run, secure, and monitor. Overkill for a single video-processing queue. Largest operational and conceptual overhead of the three.

**Recommendation:** **Option A (pg-boss)** — it reuses the PostgreSQL instance already in the stack (no Redis, no new broker), keeping the local `compose.yaml` and production footprint minimal, which matches the Postgres-first precedent set in Phases 01–02. Its built-in retry, exponential backoff, and dead-letter features are exactly what the video failure lifecycle (TD-08) needs, and its `SKIP LOCKED`/`LISTEN-NOTIFY` design is more than adequate for the low job volume of video uploads. BullMQ's throughput and RabbitMQ's routing power are real but unnecessary here, and both impose new infrastructure.

**Decision:** A: pg-boss (PostgreSQL-backed queue)

---

## TD-02: Large-File (10GB) Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must not pass through the Node/NestJS API process — buffering or streaming 10GB through the API would consume memory/CPU/bandwidth and block the event loop, directly violating "sem impacto na performance". The handshake sequence spans both sides: the browser must send bytes somewhere, and the API must authorize and finalize. This is why it is a single Cross-layer contract, not two per-layer TDs.

**Options:**

### Option A: Presigned **multipart** upload direct-to-storage (S3 multipart)
- API pre-registers the video (TD-08 `draft`) and initiates a multipart upload, returning presigned URLs for each part (≥5MB parts). The browser uploads parts **in parallel directly to MinIO/S3**, then calls the API to complete (CompleteMultipartUpload). Bytes never touch the API.
- **Pros:** Fully satisfies "sem impacto" — the API only signs URLs and finalizes metadata. Parallel parts = high throughput; **part-level retry/resume** survives flaky connections (addresses the plan's "permita retomar em caso de falha de conexão" note). Identical behavior on MinIO (local) and S3 (prod). Uses AWS SDK v3 presigner.
- **Cons:** More handshake steps (initiate → sign parts → upload → complete). Client must orchestrate part splitting and completion. Aborted/incomplete multipart uploads need a lifecycle cleanup rule.

### Option B: tus resumable upload protocol (`@tus/server` + S3 store)
- Open resumable-upload protocol; a tus server component accepts chunked uploads with pause/resume and offloads to an S3 store.
- **Pros:** Best-in-class resumability semantics; protocol-standardized client libraries; robust pause/resume.
- **Cons:** Adds a **new server component** (tus endpoint) to build, run, and secure — more moving parts than presigning against storage the project already runs. Overlaps with what S3 multipart already provides natively. Extra dependency surface for a benefit (resume) that multipart parts already deliver.

### Option C: API-proxied streaming/chunked upload
- The browser uploads to a NestJS endpoint that streams the bytes through to storage.
- **Pros:** Simplest handshake; the API keeps full control and can enforce checks inline.
- **Cons:** **Defeats the core requirement** — 10GB flows through the API process, consuming bandwidth/memory and competing with request handling. Does not scale and undermines "sem impacto na performance".

**Recommendation:** **Option A (presigned multipart direct-to-storage)** — it keeps all 10GB off the API (the only option that truly honors "sem impacto"), gives parallel transfer plus part-level resume for flaky connections, and works identically against local MinIO and production S3 via the AWS SDK v3 presigner. tus adds an extra server component for resumability that multipart already provides; proxying through the API is disqualified by the performance requirement. Incomplete multipart uploads are reaped via a storage lifecycle rule.

**Decision:** A: Presigned **multipart** upload direct-to-storage (S3 multipart)

---

## TD-03: Object-Storage Organization & Presigned Access

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage **engine is already decided** by the project (S3-compatible: MinIO locally, S3 in production) — it is *not* reopened here. What must be decided is *how to use it*: bucket/key layout, how presigned access is issued, and how storage references are persisted on the video row. This layout is a cross-component contract (upload TD-02, worker TD-05, delivery TD-07 all address the same keys) and drives the MinIO service added to `compose.yaml`.

**Options:**

### Option A: Single bucket + structured key prefixes keyed by video id
- One bucket (e.g., `streamtube-videos`) with deterministic prefixes: `videos/{videoId}/original.<ext>`, `thumbnails/{videoId}/default.jpg`. The video row persists **storage keys** (not full URLs); presigned URLs are generated on demand via AWS SDK v3 (`@aws-sdk/s3-request-presigner`) — PUT for upload parts, GET for stream/download.
- **Pros:** One bucket to provision/secure/back up. Keys are derived from the video's own id → predictable, collision-free, easy to locate all assets of a video by prefix. Lifecycle/expiry rules apply cleanly by prefix (`videos/`, `thumbnails/`, incomplete-multipart cleanup). Persisting keys (not URLs) keeps rows portable across MinIO↔S3 and lets URLs be re-signed with fresh expiry.
- **Cons:** A single bucket mixes asset types (mitigated by prefixes). Per-type policy differences must be expressed via prefix rules rather than per-bucket settings.

### Option B: Separate buckets per asset type
- Distinct `videos` and `thumbnails` buckets.
- **Pros:** Clean per-type isolation; per-bucket lifecycle/ACL policies.
- **Cons:** More buckets to provision and wire (env, policies) in both MinIO and S3. No real benefit at this scale; prefixes achieve the same separation within one bucket.

### Option C: Key by channel then video
- Prefixes like `channels/{channelId}/videos/{videoId}/...`.
- **Pros:** Mirrors ownership hierarchy in the key space.
- **Cons:** Couples the storage key to the channel; re-parenting/administrative moves become awkward. The video id alone is already globally unique, so the channel segment adds no addressing value.

**Recommendation:** **Option A (single bucket, video-id-keyed prefixes, keys persisted + on-demand presigning)** — the simplest thing to provision and secure across MinIO and S3, with deterministic keys derived from the video's id and clean prefix-based lifecycle rules (including reaping incomplete multipart uploads from TD-02). Persisting storage **keys** rather than full URLs keeps rows environment-agnostic and lets every access be a freshly-signed, short-lived URL.

**Decision:** A: Single bucket + structured key prefixes keyed by video id

---

## TD-04: Video Processing Worker Runtime & Deployment

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The C4 diagram shows a distinct **Video Worker (FFmpeg)** container that consumes jobs, reads/writes storage, and updates the DB. FFmpeg is CPU-heavy; running it inside the API process would spike latency and contradict "sem impacto na performance". The decision is *how* the worker runs and how much it shares with the API codebase.

**Options:**

### Option A: Standalone NestJS application context in a separate container
- A second entrypoint (e.g., `worker.ts`) boots the app with `NestFactory.createApplicationContext(AppModule)` (no HTTP server) and registers pg-boss workers. It **reuses the same modules, entities, config, and storage client** as the API but runs as its own process/container. The worker image additionally installs the `ffmpeg` binary.
- **Pros:** CPU-heavy FFmpeg work is isolated from the API (satisfies "sem impacto"). Zero code duplication — same TypeORM entities, `@nestjs/config` namespaces, and storage service via DI. Scales independently (run N worker containers). Matches the diagram's separate-worker topology.
- **Cons:** A second container/entrypoint to build and run. Shared codebase means a deploy touches both API and worker images.

### Option B: In-process worker inside the API
- The API process itself registers the pg-boss workers.
- **Pros:** Simplest — one process, one deployable.
- **Cons:** FFmpeg CPU spikes directly degrade API request handling — **contradicts the performance capability**. Cannot scale processing independently of the API.

### Option C: Fully separate microservice / repository
- A standalone worker service with its own codebase and its own copy of entities/config/storage logic.
- **Pros:** Maximum isolation and independent lifecycle.
- **Cons:** Duplicates entities, config, and the storage client → drift risk and double maintenance. Heavier ops for no benefit the shared-codebase approach lacks.

**Recommendation:** **Option A (standalone NestJS application context, separate container)** — it isolates FFmpeg CPU load from the API (honoring "sem impacto") while reusing the exact same modules, entities, config, and storage client through `createApplicationContext`, avoiding the code duplication of a separate service. The worker image adds the `ffmpeg` binary; the API image stays lean. This is precisely the separate-worker container the architecture diagram prescribes.

**Decision:** A: Standalone NestJS application context in a separate container

---

## TD-05: Media Tooling — Metadata Extraction & Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata and generate a thumbnail from a frame. FFmpeg is the de-facto tool; the decision is *how the Node worker invokes it*. This is strategic (not a mere implementation detail) because the popular Node wrapper is now unmaintained and the choice dictates the worker Dockerfile (which binary to install) — a cross-component concern.

**Options:**

### Option A: Direct `ffmpeg`/`ffprobe` via Node `child_process` (no wrapper)
- The worker spawns the system binaries directly: `ffprobe -v quiet -print_format json -show_format -show_streams <input>` for duration/metadata (parsed as JSON), and `ffmpeg -ss <t> -i <input> -frames:v 1 <thumb.jpg>` for the thumbnail. The `ffmpeg` binary is installed in the worker image (TD-04).
- **Pros:** No dependency on an unmaintained wrapper. Full control over flags; stable across FFmpeg versions. `ffprobe -print_format json` yields structured, easy-to-parse output. Thin, auditable surface.
- **Cons:** Must hand-write `spawn` orchestration and error handling (small, well-understood). No fluent JS builder API.

### Option B: `fluent-ffmpeg` wrapper
- The long-popular fluent JS API over FFmpeg.
- **Pros:** Ergonomic chained API; abundant historical examples.
- **Cons:** **Archived May 2025**, npm marked **"no longer supported"**, and per its own README **"no longer works properly with recent ffmpeg versions."** Adopting an abandoned, known-broken dependency for a greenfield project is an unacceptable risk. **Rejected.**

### Option C: Maintained community fork (e.g., an `@eyevinn` fork) or alternative wrapper
- A community-maintained fork of fluent-ffmpeg or a different wrapper library.
- **Pros:** Keeps a fluent API while being (currently) maintained.
- **Cons:** Fork longevity/ownership is uncertain; smaller community and support surface. Adds a dependency layer over binaries the worker already has, for ergonomics only.

**Recommendation:** **Option A (direct `ffprobe`/`ffmpeg` via `child_process`)** — the canonical wrapper (`fluent-ffmpeg`) is archived, npm-flagged "no longer supported", and documented as broken with recent FFmpeg, so it must not anchor a new codebase. A thin `spawn` around `ffprobe -print_format json` (metadata/duration) and `ffmpeg -ss … -frames:v 1` (thumbnail) is stable, dependency-free, fully controllable, and needs only the `ffmpeg` binary that the worker image already installs.

**Decision:** A: Direct `ffmpeg`/`ffprobe` via Node `child_process` (no wrapper)

---

## TD-06: Unique Per-Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, URL-friendly, collision-free public identifier that never clashes with another video. It is a Cross-layer contract: the backend generates and looks it up; the frontend uses it in routes (`/watch/{publicId}` etc.). The internal `uuid` primary key is unsuitable for public URLs (long, exposes nothing useful, ugly). A key compatibility constraint applies: the backend is **CommonJS** NestJS.

**Options:**

### Option A: `nanoid` pinned to v3 (CommonJS-compatible) → short `public_id` column
- Generate a short URL-safe id (default 21 chars, tunable) stored in a unique `public_id` column, separate from the internal `uuid` PK. **`nanoid` v4/v5 are ESM-only and throw `ERR_REQUIRE_ESM` under CommonJS**, so pin **`nanoid@^3`** (the last CJS line).
- **Pros:** Purpose-built for short, URL-safe, collision-resistant ids; tiny and fast. Clean separation: `uuid` PK for relations, `public_id` for external URLs. Collision probability is negligible and a unique constraint + retry closes the gap. `v3` works in the project's CommonJS build with a plain `import`.
- **Cons:** Must **pin to the older v3 major** (v5 would break the CJS build) — a documented constraint to hold. Adds one dependency and one indexed column.

### Option B: Reuse `uuid` v4 as the public URL id
- Expose the existing primary key in URLs.
- **Pros:** No new column, no new dependency; guaranteed unique.
- **Cons:** 36-char, hyphenated, unfriendly URLs. Leaks the internal PK into the public surface, coupling external URLs to internal identity.

### Option C: Custom short code (base62/base58, or `hashids` from a sequence/uuid)
- Encode a value into a short alphanumeric slug in application code.
- **Pros:** Full control over length/alphabet; no ESM/CJS concern; short URLs.
- **Cons:** Hand-rolled collision handling (or a counter that leaks volume via `hashids`). Reinvents what `nanoid` already solves; more code to test.

**Recommendation:** **Option A (`nanoid@^3`, dedicated `public_id` column)** — it delivers short, URL-safe, collision-resistant identifiers with a tiny, well-understood library, keeping the internal `uuid` PK out of public URLs. The one caveat is **pinning to `nanoid@^3`**: the project's CommonJS NestJS build cannot `require()` the ESM-only v4/v5 (`ERR_REQUIRE_ESM`). A unique index on `public_id` plus generate-and-retry-on-conflict guarantees no collisions.

**Decision:** B: Reuse `uuid` v4 as the public URL id

**Note:** Decision deliberately diverged from the Recommendation (Option A, `nanoid@^3`). Reusing the existing `uuid` v4 primary key as the public URL id keeps zero extra dependencies and sidesteps the ESM/CommonJS `nanoid` constraint entirely, accepting longer, less "pretty" URLs as the trade-off. This divergence is also an intentional choice for this phase — keeping at least one decision that departs from the recommendation, as a learning exercise around the research/planning skills and agentic-programming behavior.

---

## TD-07: Streaming & Download Delivery (HTTP Range / 206)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP Range → `206 Partial Content`), and users must be able to download the file. The C4 diagram draws the delivery edge as **Frontend → Object Storage ("Streams")**, i.e., the browser streams from storage, not through the API. The decision — where range requests are served and how the download is triggered — is a Cross-layer contract (backend issues access; frontend `<video>`/anchor consumes it).

**Options:**

### Option A: Presigned GET direct-from-storage with native Range/206
- The API issues a short-lived presigned GET URL; the browser's `<video>` element requests it directly from MinIO/S3, which **implements HTTP Range/`206` natively**. Download uses the same presigned GET with `response-content-disposition=attachment`.
- **Pros:** All streaming bandwidth is offloaded to the storage layer (honors "sem impacto" and scales). Range/206 works out of the box — no custom byte-range code. Matches the diagram's "Frontend streams from Object Storage" edge. Short-lived presigned URLs preserve access control (important once unlisted videos arrive in Phase 04+) without proxying bytes. Download is the same primitive plus a content-disposition override.
- **Cons:** Presigned URLs are time-limited (the player must handle re-signing for very long sessions). Fine-grained per-request authorization is coarser than a proxy (mitigated by short expiry + API-gated issuance).

### Option B: API-proxied range streaming
- A NestJS endpoint reads from storage and re-streams with manual `Range`/`206` handling.
- **Pros:** Full per-request control (auth, logging) at the byte level.
- **Cons:** Funnels **all** video bandwidth (including 10GB downloads) through the Node API — contradicts "sem impacto" and does not scale. Requires hand-written range/206 logic.

### Option C: Public bucket + CDN
- Serve objects publicly via a CDN.
- **Pros:** Best scale and latency; simplest client wiring.
- **Cons:** Public objects **lose access control** — incompatible with the unlisted-video requirement coming in Phase 04+. CDN provisioning is a production optimization, premature for this phase.

**Recommendation:** **Option A (presigned GET direct-from-storage, native Range/206)** — it matches the architecture diagram's "Frontend streams from Object Storage" edge, offloads all streaming/download bandwidth to storage (honoring "sem impacto" and scaling), and gets Range/`206` for free from the S3/MinIO layer. Presigned, API-issued, short-lived URLs retain access control (needed for unlisted videos later) without proxying bytes; download reuses the same URL with a content-disposition override. Proxying through the API is disqualified on bandwidth; a public CDN is premature and breaks unlisted access control.

**Decision:** A: Presigned GET direct-from-storage with native Range/206

---

## TD-08: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video is pre-registered as a **draft** when upload starts, then moves through processing to a terminal state, with a defined behavior when processing fails. This lifecycle is the contract between the upload endpoint (TD-02), the queue (TD-01), and the worker (TD-04/05). Only the *strategic shape* of the status is decided here; the full `videos` column set is a `plan-phase` Data Model concern.

**Options:**

### Option A: Explicit status enum state machine + queue-driven failure handling
- A single `status` enum column drives an explicit machine: `draft` (pre-registered at upload start) → `processing` (job dequeued) → `ready` (metadata + thumbnail persisted) | `failed` (terminal error). Transitions are owned by the video service. Transient failures are retried by pg-boss (`retry_limit` + `retry_backoff`, TD-01); on dead-letter (retries exhausted) the handler sets `failed` with an error reason. The job handler is **idempotent, keyed by `videoId`**, so retries are safe.
- **Pros:** One unambiguous state at all times; trivial to query ("show my drafts", "show failed"). Maps cleanly onto pg-boss states and dead-letter. Idempotency + retries handle transient FFmpeg/storage errors without duplicate side effects. Extensible (e.g., a future `uploading` sub-state) without schema churn.
- **Cons:** Requires disciplined transition guards to prevent illegal jumps (e.g., `ready`→`draft`).

### Option B: Boolean flags (`is_draft`, `is_processing`, `is_ready`, `has_error`)
- Independent booleans per condition.
- **Pros:** Trivial to add a flag.
- **Cons:** Permits contradictory combinations (`is_ready && has_error`), no single source of truth, awkward queries. Anti-pattern for a lifecycle with mutually-exclusive states.

### Option C: Separate `processing_jobs` table + derived video status
- A dedicated table tracks attempts/outcomes; the video's status is derived from it.
- **Pros:** Rich processing history and per-attempt auditing.
- **Cons:** pg-boss **already** records attempts, states, and dead-letter — this duplicates the queue's own bookkeeping. Extra join/derivation complexity beyond what the phase needs.

**Recommendation:** **Option A (explicit status enum state machine, queue-driven failures)** — a single `status` enum (`draft → processing → ready | failed`) gives one unambiguous state that is easy to query and maps directly onto pg-boss's retry/backoff/dead-letter machinery from TD-01. An idempotent, `videoId`-keyed handler makes retries safe, and terminal (dead-lettered) failures set `failed` with a reason. Boolean flags allow contradictory states; a separate jobs table duplicates pg-boss's own tracking.

**Decision:** A: Explicit status enum state machine + queue-driven failure handling

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Message queue technology | pg-boss (PostgreSQL-backed; no Redis) | A: pg-boss (PostgreSQL-backed queue) |
| TD-02 | Cross-layer | 10GB upload strategy | Presigned multipart direct-to-storage | A: Presigned multipart upload direct-to-storage (S3 multipart) |
| TD-03 | Backend | Object-storage organization & presigned access | Single bucket, video-id key prefixes, keys persisted + on-demand presigning | A: Single bucket + structured key prefixes keyed by video id |
| TD-04 | Backend | Worker runtime & deployment | Standalone NestJS app context in a separate container | A: Standalone NestJS application context in a separate container |
| TD-05 | Backend | Metadata & thumbnail tooling | Direct `ffprobe`/`ffmpeg` via `child_process` | A: Direct ffmpeg/ffprobe via Node child_process (no wrapper) |
| TD-06 | Cross-layer | Unique per-video URL identifier | `nanoid@^3` (CJS) → `public_id` column | B: Reuse uuid v4 as the public URL id |
| TD-07 | Cross-layer | Streaming & download delivery | Presigned GET direct-from-storage, native Range/206 | A: Presigned GET direct-from-storage with native Range/206 |
| TD-08 | Backend | Video status lifecycle & failure handling | Explicit status enum state machine + pg-boss retries/dead-letter | A: Explicit status enum state machine + queue-driven failure handling |

