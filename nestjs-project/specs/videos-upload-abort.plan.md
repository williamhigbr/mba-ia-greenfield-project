---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-abort.e2e-spec.ts
---

# POST /videos/:id/abort-upload — Abortar upload — Test Plan

## Application Overview

`POST /videos/:id/abort-upload` cancela um upload multipart em andamento, libera as partes no object storage e remove o rascunho. Só o owner pode abortar, e apenas enquanto o vídeo está em `draft`.

## Test Scenarios

### 1. POST /videos/:id/abort-upload

**Setup:** `beforeEach` trunca `videos`/`channels`/`users`; bootstrap do módulo Nest reproduzindo a config global de `main.ts`; StorageService real (MinIO de teste); fixtures criam owner + canal + um vídeo em `draft` com upload multipart em andamento. `afterAll(() => app.close())`.

#### 1.1. aborta-draft-e-remove-row

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos/:id/abort-upload como owner sobre um vídeo em `draft`
    - expect: status 204
    - expect: corpo vazio
    - expect: a row `videos` do `:id` não existe mais
    - expect: o multipart upload correspondente foi abortado no storage (objeto final ausente)

#### 1.2. rejeita-nao-owner

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos/:id/abort-upload autenticado como um usuário diferente do dono
    - expect: status 403
    - expect: body `error` = `"VIDEO_NOT_OWNER"`
    - expect: a row `videos` continua existindo em `draft`

#### 1.3. rejeita-estado-nao-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos/:id/abort-upload como owner sobre um vídeo já em `processing`
    - expect: status 409
    - expect: body `error` = `"INVALID_UPLOAD_STATE"`

#### 1.4. exige-autenticacao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos/:id/abort-upload sem header Authorization
    - expect: status 401
