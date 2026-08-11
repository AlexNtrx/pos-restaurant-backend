# Backend AGENTS.md

Follow `../AGENTS.md`.

- This repository contains the Express and Prisma backend API.
- Authenticate and authorize protected operations on the server.
- Never trust client-controlled identity, permissions, prices, totals, or financial values.
- Validate requests and important business invariants.
- Keep middleware, controller, business logic, database, and file-storage responsibilities separate.
- Use transactions when related writes must succeed or fail together.
- Preserve consistent HTTP status codes, safe errors, and approved API contracts.
- Review the Prisma schema and migrations before database changes.
- Run tests and data operations only against an approved disposable database.
- Never run destructive migrations or data scripts without explicit approval.
- Do not modify frontend files during backend-only work.
- Run the relevant backend tests, Prisma checks, syntax checks, and Prettier check for the change.
