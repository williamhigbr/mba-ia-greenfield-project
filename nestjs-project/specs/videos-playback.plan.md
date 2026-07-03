---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/:id — Metadados, streaming e download — Test Plan

## Application Overview

Estes endpoints expõem a visão de metadados do vídeo (`GET /videos/:id`) e a entrega de bytes por streaming (`GET /videos/:id/stream`) e download (`GET /videos/:id/download`). Streaming e download respondem `302` redirecionando para uma URL presigned GET servida direto do storage (Range/206 nativo). São públicos: anônimos só enxergam vídeos `ready`; o owner enxerga qualquer status.

## Test Scenarios

### 1. GET /videos/:id (metadados)

**Setup:** `beforeEach` trunca `videos`/`channels`/`users`; bootstrap do módulo Nest reproduzindo a config global de `main.ts`; StorageService real (MinIO de teste); fixtures criam owner + canal + vídeos em estados variados (`ready` com `thumbnail_key`/`duration_seconds`/`metadata`, `processing`). `afterAll(() => app.close())`.

#### 1.1. retorna-metadados-de-video-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. GET /videos/:id (anônimo) de um vídeo `ready`
    - expect: status 200
    - expect: body contém `status: "ready"`, `durationSeconds` (number), `metadata` (object) e `thumbnailUrl` (URL presigned não nula)

#### 1.2. esconde-video-nao-ready-de-anonimo

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. GET /videos/:id (anônimo, sem Authorization) de um vídeo em `processing`
    - expect: status 404
    - expect: body `error` = `"VIDEO_NOT_FOUND"`

### 2. GET /videos/:id/stream e /download

**Setup:** herda o mesmo bootstrap da seção 1.

#### 2.1. redireciona-stream-de-video-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. GET /videos/:id/stream de um vídeo `ready` (sem seguir redirect)
    - expect: status 302
    - expect: header `Location` presente apontando para uma URL presigned GET do storage

#### 2.2. redireciona-download-com-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. GET /videos/:id/download de um vídeo `ready` (sem seguir redirect)
    - expect: status 302
    - expect: header `Location` presente, e a URL presigned carrega `response-content-disposition=attachment`

#### 2.3. bloqueia-stream-de-video-nao-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-03T00:08:02Z

**Steps:**
  1. GET /videos/:id/stream de um vídeo em `processing`
    - expect: status 409
    - expect: body `error` = `"VIDEO_NOT_READY"`
