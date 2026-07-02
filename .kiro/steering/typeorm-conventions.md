# TypeORM Conventions

Rules for TypeORM queries and migrations in `nestjs-project/`.

---

## Query Pitfalls

### `null` in `where` is silently dropped

`where: { someField: null }` does NOT generate `WHERE some_field IS NULL`. Use the `IsNull()` helper:

```typescript
import { IsNull, Not } from 'typeorm';

repo.findOne({ where: { confirmedAt: IsNull() } });
repo.find({ where: { revokedAt: Not(IsNull()) } });
```

### PostgreSQL aborts transaction on constraint violation

Inside `dataSource.transaction(...)`, any error puts the transaction in an aborted state. For retry-on-collision patterns, wrap each attempt in a SAVEPOINT:

```typescript
await dataSource.transaction(async (manager) => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await manager.query(`SAVEPOINT attempt_${attempt}`);
    try {
      await manager.save(entity);
      await manager.query(`RELEASE SAVEPOINT attempt_${attempt}`);
      return;
    } catch (err) {
      await manager.query(`ROLLBACK TO SAVEPOINT attempt_${attempt}`);
      if (!isUniqueViolation(err) || attempt === MAX_ATTEMPTS - 1) throw err;
    }
  }
});
```

### `findOne` vs `findOneOrFail`

- `findOne` returns `null` — caller handles and throws domain exception.
- `findOneOrFail` throws `EntityNotFoundError` — use only when absence is genuinely exceptional.
- Prefer `findOne` + explicit domain exception in service code.

### Selecting `select: false` columns

Load sensitive columns explicitly when needed:

```typescript
repo.findOne({ where: { email }, select: ['id', 'email', 'passwordHash'] });
```

Never remove `select: false` from the entity.

---

## Migrations

### Immutability

- Never edit a migration already executed — create a new one.
- To revert, write a new migration that undoes the change.

### Generation

- Always generate via TypeORM CLI (`migration:generate` or `migration:create`).
- Write SQL by hand only when CLI cannot express the change (data migrations).

### Safety

- Never `synchronize: true` in any environment.
- Test against a fresh database before considering done.
- Use `IF EXISTS` / `IF NOT EXISTS` guards for DDL.

### Recovering from `synchronize` Residue

If tables exist but no migration on disk:
1. Drop orphan tables (`DROP TABLE ... CASCADE`).
2. Clear stale rows in `migrations` table.
3. `migration:generate` against empty DB → produces complete CREATE TABLE.
4. Run the new migration.

### Tests

- Restore DB state in `afterAll` (`dataSource.runMigrations()`).
- Import migration classes directly in test DataSources (globs break in `ts-jest`).
- Pass entity classes explicitly in test DataSources (not glob strings).
