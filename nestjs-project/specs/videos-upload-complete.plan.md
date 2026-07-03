---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/complete — Completar upload e enfileirar processamento — Test Plan

## Application Overview

`POST /videos/:id/complete` finaliza o upload multipart no storage (montando as partes), transiciona o vídeo de `draft` para `processing` e enfileira o job `video-process`. Só o owner (dono do canal do vídeo) pode completar.

## Test Scenarios

### 1. POST /videos/:id/complete

**Setup:** `beforeEach` trunca `videos`/`channels`/`users` e limpa as filas pg-boss do banco de teste; bootstrap do módulo Nest reproduzindo a config global de `main.ts`; StorageService (MinIO de teste) e QueueService (pg-boss no DB de teste) reais; fixtures criam owner + canal + um vídeo em `draft` com upload multipart em andamento. `afterAll(() => app.close())`.

#### 1.1. completa-upload-e-transiciona-para-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. POST /videos/:id/complete como owner com body `{ parts: [{ partNumber: 1, etag: "\"abc123\"" }] }`
    - expect: status 200
    - expect: body `{ id, status: "processing" }`
    - expect: existe exatamente um job na fila `video-process` com payload `{ videoId: id }`
    - expect: a row `videos` tem `status = 'processing'` e `upload_id` nulo

#### 1.2. rejeita-nao-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. POST /videos/:id/complete autenticado como um usuário diferente do dono do vídeo
    - expect: status 403
    - expect: body `error` = `"VIDEO_NOT_OWNER"`
    - expect: nenhum job enfileirado; `status` permanece `draft`

#### 1.3. rejeita-estado-nao-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. POST /videos/:id/complete como owner sobre um vídeo já em `processing`
    - expect: status 409
    - expect: body `error` = `"INVALID_UPLOAD_STATE"`

#### 1.4. rejeita-video-inexistente

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. POST /videos/:id/complete como usuário autenticado com um `:id` uuid que não existe
    - expect: status 404
    - expect: body `error` = `"VIDEO_NOT_FOUND"`

#### 1.5. rejeita-body-invalido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. POST /videos/:id/complete como owner com body `{}` sem `parts` (prova o wiring do ValidationPipe do DTO)
    - expect: status 400
    - expect: body reporta erro de validação para o campo obrigatório `parts`
