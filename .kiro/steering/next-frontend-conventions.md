# Next.js Frontend Conventions

Rules for `next-frontend/` — code quality, BFF API layer, UI tokens, MSW mocks, and testing.

---

## Code Quality

### TypeScript

- Strict mode (`strict: true`). **No `any`** — use `React.ComponentProps<"tag">` for DOM props.
- `npx tsc --noEmit` must exit 0 before any task is done.
- Use `import type` for type-only imports. Inline form for mixed: `import { cn, type ClassValue }`.

### Import Order

1. Node built-ins → 2. Third-party → 3. `@/...` aliases → 4. Relative imports. Separated by blank lines.

### Path Aliases

- Always `@/...` aliases. Never deep relative paths (`../../`). One level (`./sibling`) is fine within a feature folder.

### File Placement & Naming

- Feature / page components under `app/<route>/`.
- Cross-route reusable composites under `components/<feature>/` (one subfolder per feature).
- Never mix custom composites into `components/ui/` (reserved for shadcn).
- File names: kebab-case. Exports: PascalCase (components) or camelCase (utils/hooks).
- One primary export per file.

### React Server Components

- Components are Server Components by default.
- Add `"use client"` only when needed (state, effects, refs, browser APIs, event handlers). Keep the boundary as deep as possible.

### `cn(...)` for className

Use `cn(...)` from `@/lib/utils` for every conditional/merged className. Never string-concatenate Tailwind classes manually.

### Next.js Primitives

- `next/image` for raster images (never plain `<img>`).
- `next/link` for internal navigation (never plain `<a>`).
- `next/font` for typography (wired in `app/layout.tsx`).

### Environment Access

Import `env` from `@/lib/env` only. Never `process.env.X` directly in feature code.

---

## BFF API Layer

### File Map

| File | Role |
|---|---|
| `openapi.json` | Committed local copy of upstream OpenAPI spec. Refreshed by `scripts/sync-openapi.sh`. |
| `lib/api/types.gen.ts` | Generated `paths` interface. **Never edit.** Regenerate via `npm run openapi:types`. |
| `lib/api/upstream.ts` | Server-only typed HTTP client. The only module that calls upstream. |
| `lib/api/contracts.ts` | BFF↔components barrel. Only file authorized to import `paths` (with `mocks/` exception). |

### Route Handler Pattern

- Import `upstream` from `@/lib/api/upstream`. Never re-instantiate per-route.
- Return shapes typed via aliases from `@/lib/api/contracts` (not directly off `paths`).
- Destructured triple `{ data, error, response }` narrows by `if (error)`.

### What Does NOT Belong

- No hand-written DTOs — derive from `paths`.
- No raw `fetch(env.API_URL + ...)` in Route Handlers — use `upstream`.
- No `paths` imports from feature components (use aliases from `contracts.ts`).
- No upstream calls from the browser (BFF model — direct browser→upstream is forbidden).

### `upstream.ts` — Server-Only

Starts with `import "server-only"`. Do not remove. Do not add `"use client"` to importers. Register middleware once at module load (not per-request).

---

## UI Rules

### Design Tokens — Consume, Never Hardcode

All tokens live in `app/globals.css`. When consuming:
- Never hardcode colors, radii, spacing, font sizes, shadows, or weights.
- Never add a new token in a component file — add to `globals.css` first.
- When extending Tailwind utilities beyond defaults, register in `extendTailwindMerge` config in `lib/utils.ts`.

### Semantic Colors (preferred)

`bg-background`, `text-foreground`, `bg-primary`, `bg-secondary`, `bg-muted`, `bg-accent`, `bg-destructive`, `bg-success`, `bg-warning`, plus `-foreground` variants; `border-border`, `border-input`, `ring-ring`, etc.

### Typography

Custom text styles: `text-display`, `text-h1`–`text-h3`, `text-body-lg`, `text-body-md`, `text-caption`, `text-label-*`, `text-helper`, `text-overlay`. Do NOT combine with `leading-*` or manual font weights unless Figma explicitly overrides.

### Radius, Spacing, Shadows

- Radius: `rounded-[var(--radius-{N})]`. Spacing: standard Tailwind utilities. No arbitrary values like `p-[17px]`.
- Named shadows only: `shadow-card`, `shadow-drawer-left`, etc.

### Dark Mode

Driven by `prefers-color-scheme: dark` overriding semantic vars. Components react automatically. Only use `dark:` for asset swaps or palette-scale tokens without semantic equivalent.

### Shadcn Primitives (`components/ui/`)

1. Define styles with `cva([...base], { variants, defaultVariants })`.
2. Plain function component (no `forwardRef`, no `displayName`), typed as `React.ComponentProps<"…"> & VariantProps<typeof xVariants>`. Accept `asChild` with `Slot`.
3. Set `data-slot`, `data-variant`, `data-size`. Compose with `cn(xVariants({ variant, size, className }))`.
4. State via ARIA/data attributes: `disabled:…`, `aria-invalid:…`, `data-[loading=true]:…`.
5. Run `npx shadcn@latest add <component>` (never manual). Replace external icon imports with `@/components/icons/`. Reconcile with Figma tokens after install.

### Icons (`components/icons/`)

- No external icon library. All icons are custom React components with inline `<svg>`.
- Typed as `React.ComponentProps<"svg">`. Spread props, merge className via `cn(...)`.
- Use `currentColor` for stroke/fill. Set `viewBox`, omit hardcoded width/height. Include `aria-hidden="true"`.

---

## MSW Mocks

### Structure

- `mocks/handlers/<domain>.ts` — handlers per API domain.
- `mocks/handlers/index.ts` — barrel re-export.
- `mocks/factories/<domain>.ts` — deterministic `buildX(overrides?)` factories.
- `mocks/server.ts` — `setupServer(...handlers)`.
- `mocks/setup.ts` — lifecycle (`listen({ onUnhandledRequest: "error" })`, `resetHandlers`, `close`).

### Typing Convention

Handlers type fixtures via `paths` from `@/lib/api/types.gen` (documented exception to contracts-barrel rule). Hand-written deterministic handlers only — no faker-randomized auto-generated handlers.

### URL Composition

Use `${env.API_URL}/...` so handlers match actual BFF calls.

---

## Testing

### Forbidden Pattern

Never hit the upstream API directly from Vitest tests. Use:
- `*.e2e-spec.ts` (Playwright) for full-app flows.
- `*.integration.test.ts` (Vitest + MSW) for BFF isolation.

### File Placement

- Unit/integration next to code: `__tests__/*.test.tsx`, `__tests__/*.integration.test.ts`.
- E2E at project root: `tests/*.e2e-spec.ts`.

### DOM Rendering

Default environment is `node`. Tests rendering JSX must opt in with `// @vitest-environment jsdom` docblock at the top of the file.

### Route Handler Integration Tests

1. Import handler from route module.
2. Construct a `Request` / `NextRequest`.
3. MSW intercepts upstream calls (configured in `setupFiles`).
4. Assert on the `Response`: status, headers, JSON body.
