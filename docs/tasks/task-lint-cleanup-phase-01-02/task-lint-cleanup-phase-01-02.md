---
kind: task
name: task-lint-cleanup-phase-01-02
test_specs_aware: false
---

# task-lint-cleanup-phase-01-02

## Objective

Zerar os **150 erros de ESLint pré-existentes** herdados das fases 01/02 para que o gate da Definition of Done `npx eslint "{src,apps,libs,test}/**/*.ts"` saia com código `0`. Os erros foram detectados na verificação final da fase 03 (ver `docs/phases/phase-03-videos/progress.md → Final Verification`), mas **não foram introduzidos pela fase 03** — todos os arquivos ofensores tiveram seu último commit antes da fase 03. A fase 03 apenas os expôs ao rodar a suíte/lint completos.

Fora de escopo: os **40 warnings** `@typescript-eslint/no-unsafe-argument` (rebaixados a `warn` propositalmente no `eslint.config.mjs`) — não bloqueiam o gate (ESLint só sai diferente de 0 em `error`). Nenhuma mudança funcional ou cosmética não relacionada.

---

## Technical Specifications

### Inventário de erros (errors-only, 150 total)

| Regra | Qtde | Severidade |
|---|---|---|
| `@typescript-eslint/no-unsafe-member-access` | 76 | error |
| `@typescript-eslint/no-unsafe-assignment` | 41 | error |
| `@typescript-eslint/unbound-method` | 19 | error |
| `@typescript-eslint/no-unsafe-return` | 6 | error |
| `@typescript-eslint/require-await` | 4 | error |
| `@typescript-eslint/no-unused-vars` | 2 | error |
| `@typescript-eslint/no-unsafe-function-type` | 1 | error |
| `@typescript-eslint/no-unsafe-call` | 1 | error |

### Distribuição por arquivo (errors-only)

| Arquivo | Erros | Natureza |
|---|---|---|
| `test/auth.e2e-spec.ts` | 48 | teste — `res.body` é `any` (supertest) |
| `src/auth/auth.service.spec.ts` | 45 | teste — 19 `unbound-method` + 26 mock `any` |
| `src/mail/mail.service.integration-spec.ts` | 16 | teste — resposta Mailpit `any` |
| `src/channels/channels.service.spec.ts` | 15 | teste — mock `any` |
| `src/auth/auth.service.integration-spec.ts` | 7 | teste |
| `src/common/filters/domain-exception.filter.spec.ts` | 7 | teste |
| `src/channels/channels.service.ts` | 6 | **produção** — bloco `err as any` |
| `src/common/filters/validation-exception.filter.spec.ts` | 2 | teste |
| `src/config/env.validation.integration-spec.ts` | 2 | teste |
| `src/test/create-test-data-source.ts` | 1 | infra — tipo `Function` (linha 9) |
| `src/users/users.service.integration-spec.ts` | 1 | teste |

### Estratégia

Corrigir (tipar), não relaxar — coerente com a decisão já demonstrada na fase 03 (SI-03.5: todos os arquivos da fase 03 foram feitos lint-clean tipando `res.body`, evitando internals, etc.). Exceção justificada: adicionar `eslint-plugin-jest` para a categoria `unbound-method`, o que é a solução idiomática (não um relaxamento — `jest/unbound-method` ainda detecta unbounds reais, apenas entende `expect(mock.method)`).

### Gate final (Definition of Done)

- `npx eslint "{src,apps,libs,test}/**/*.ts"` sai `0` (0 errors; warnings permitidos).
- `npx tsc --noEmit` sai `0`.
- Suíte completa verde: `npm test -- --runInBand` e `npm run test:e2e -- --runInBand`.

---

## Step Implementations

### SI-1 — ESLint: adicionar `eslint-plugin-jest` + override para arquivos de teste

**Description:** Resolver a categoria `unbound-method` (19 erros, todos em `auth.service.spec.ts`), originada do padrão idiomático `expect(mock.method).toHaveBeenCalledWith(...)`. A correção canônica é trocar o `unbound-method` do core pela versão do `eslint-plugin-jest` nos arquivos de teste.

**Technical actions:**

1. Instalar `eslint-plugin-jest` (dev, versão compatível com ESLint 9 flat config — v28+; verificar via context7 antes de fixar).
2. Em `eslint.config.mjs`, adicionar um bloco de override com `files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts']` que: registra o plugin `jest`, desliga `@typescript-eslint/unbound-method` e liga `jest/unbound-method: 'error'`.

**Tests:** _(nenhum — config de lint)_

**Dependencies:** none

**Acceptance criteria:**

- `npx eslint src/auth/auth.service.spec.ts` não reporta nenhum `unbound-method`.
- Contagem global de erros cai de 150 para 131.
- `npx tsc --noEmit` continua `0`; suíte de `auth.service.spec.ts` continua verde.

---

### SI-2 — Produção + infra: tipar `channels.service.ts` e `create-test-data-source.ts`

**Description:** Eliminar os únicos erros fora de arquivos de teste — o bloco `err as any` do handler de colisão de nickname (fase 02) e o tipo `Function` no helper de DataSource de teste.

**Technical actions:**

1. `src/channels/channels.service.ts`: substituir `const e = err as any` por narrowing tipado sobre `QueryFailedError.driverError` (interface local `PgDriverError { code?: string; detail?: string }`). Remove os 6 `no-unsafe-*`.
2. `src/test/create-test-data-source.ts` (linha 9): substituir o parâmetro `Function` por tipo próprio do TypeORM — `NonNullable<DataSourceOptions['entities']>` (`import type { DataSourceOptions } from 'typeorm'`). Remove o `no-unsafe-function-type`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `channels.service.ts` | Integration (já existente) — colisão de nickname resolve com sufixo | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npx eslint src/channels/channels.service.ts src/test/create-test-data-source.ts` → 0 erros.
- `channels.service.integration-spec.ts` continua verde (o narrowing preserva o comportamento de detecção de violação única).
- `npx tsc --noEmit` continua `0`.

---

### SI-3 — E2E: tipar `res.body` em `test/auth.e2e-spec.ts`

**Description:** Maior concentração de erros (48). O `res.body` do supertest é `any`; tipar o corpo uma vez por asserção e ler dele. Corrigir também o `require-await` (arrow async sem await no override de provider).

**Technical actions:**

1. Para cada acesso a `res.body`, castar para a forma esperada (derivar de DTOs/tipos de resposta existentes de auth quando houver; senão interface inline mínima — ex.: `{ access_token: string; refresh_token: string }`, `{ error: string }`).
2. Remover `async` do factory de provider que não usa `await` (linha ~67) ou adicionar o `await` cabível.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| fluxo auth completo | E2E (supertest) — reexecutar `--runInBand` | `test/auth.e2e-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npx eslint test/auth.e2e-spec.ts` → 0 erros.
- `npm run test:e2e -- --runInBand` verde (7 suites / 71 tests).

---

### SI-4 — Unit/integration specs: tipar mocks e respostas restantes

**Description:** Zerar os erros remanescentes nos demais specs (mesmas categorias `no-unsafe-*`): `auth.service.spec.ts` (26 após SI-1), `mail.service.integration-spec.ts` (16), `channels.service.spec.ts` (15), `auth.service.integration-spec.ts` (7), `domain-exception.filter.spec.ts` (7), `validation-exception.filter.spec.ts` (2), `env.validation.integration-spec.ts` (2), `users.service.integration-spec.ts` (1).

**Technical actions:**

1. Tipar retornos de mock (`mockResolvedValue`/`mockReturnValue`) com o tipo real da entidade/DTO em vez de `... as any` sempre que viável; onde um objeto parcial for intencional, usar `Partial<T>` + `as T` no ponto de fronteira.
2. Tipar corpos de resposta (`res.body`, respostas de Mailpit) via interfaces mínimas.
3. Remover as 2 variáveis não usadas (`no-unused-vars`).

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| specs afetados | Unit + Integration — reexecutar `--runInBand` | (os 8 arquivos acima) |

**Dependencies:** SI-1 _(o override de teste precisa existir para não recontar `unbound-method`)_

**Acceptance criteria:**

- `npx eslint "{src,apps,libs,test}/**/*.ts"` → **0 errors** (warnings permitidos).
- `npx tsc --noEmit` → `0`.
- Suíte completa verde: `npm test -- --runInBand` (29 suites / 184 tests) e `npm run test:e2e -- --runInBand` (7 suites / 71 tests).

---

## Dependency Map

- SI-1 → (habilita contagem correta em) SI-4
- SI-2, SI-3 independentes
- SI-4 depende de SI-1

Ordem de execução: SI-1 → SI-2 → SI-3 → SI-4 (verificação de lint após cada uma).

## Deliverables

- `eslint.config.mjs` com override de teste + `eslint-plugin-jest` em `package.json`/`package-lock.json`.
- 11 arquivos corrigidos (1 produção, 1 infra, 9 testes) — sem mudança de comportamento.
- Gate de lint verde (0 errors) + `tsc` limpo + suíte completa verde.
- `progress.md` atualizado por SI.
