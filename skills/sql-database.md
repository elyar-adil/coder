# SQL Database Skill

Use this skill when working with SQL databases and ORMs.

## Guidelines
- Always use parameterized queries — never interpolate user input into SQL
- Use migrations for schema changes, never manual ALTER statements
- Test migrations up AND down (rollback)
- Index columns used in WHERE, JOIN, and ORDER BY
- Use transactions for multi-step operations
- Keep queries in separate files or a dedicated queries module
- Use connection pooling in production

## ORM conventions
- Define model schemas with explicit column types
- Add created_at / updated_at timestamps
- Use soft deletes (deleted_at) when audit trail is needed
- Keep business logic in services, not models
