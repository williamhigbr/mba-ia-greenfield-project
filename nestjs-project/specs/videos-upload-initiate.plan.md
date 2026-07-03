---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload-initiate.e2e-spec.ts
---

# POST /videos — Pré-cadastro e início do upload — Test Plan

## Application Overview

`POST /videos` cria o vídeo como `draft`, inicia o upload multipart no object storage e devolve as URLs presigned das partes. É o ponto de entrada do fluxo de upload de até 10GB — os bytes são enviados pelo navegador direto ao storage, nunca pela API.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeEach` trunca as tabelas `videos`/`channels`/`users` (`dataSource.query('DELETE FROM ...')`); bootstrap do módulo Nest com `Test.createTestingModule` reproduzindo a config global de `main.ts` (ValidationPipe, filtros); StorageService apontando para o MinIO de teste; usuário autenticado + canal criados por fixture. `afterAll(() => app.close())`.

#### 1.1. cria-draft-e-retorna-presigned-parts

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos com Authorization Bearer válido e body `{ filename: "clip.mp4", contentType: "video/mp4", size: 52428800 }`
    - expect: status 201
    - expect: body contém `id` (uuid), `uploadId` (string não vazia), `key`, `partSize` e `parts` (array de `{ partNumber, url }`)
    - expect: existe uma row em `videos` com `status = 'draft'` e `channel_id` igual ao canal do usuário autenticado

#### 1.2. rejeita-arquivo-acima-de-10gb

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos com body `{ filename: "big.mp4", contentType: "video/mp4", size: 10737418241 }`
    - expect: status 400
    - expect: body `error` = `"FILE_TOO_LARGE"`
    - expect: nenhuma row criada em `videos`

#### 1.3. rejeita-content-type-nao-video

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos com body `{ filename: "doc.pdf", contentType: "application/pdf", size: 1024 }`
    - expect: status 415
    - expect: body `error` = `"UNSUPPORTED_MEDIA_TYPE"`

#### 1.4. exige-autenticacao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos sem header Authorization com body válido
    - expect: status 401

#### 1.5. rejeita-body-invalido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T15:55:03Z

**Steps:**
  1. POST /videos autenticado com body vazio `{}` (prova o wiring do ValidationPipe do DTO)
    - expect: status 400
    - expect: body reporta erro de validação para os campos obrigatórios `filename`/`contentType`/`size`
