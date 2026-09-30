# Restaurant POS & KDS — Backend

The Express and Prisma API for counter sales, QR orders, table sessions, kitchen preparation, waiter service, payments, receipts, and reports. The backend verifies identity, authorization, availability, prices, totals, and financial records.

- [Frontend repository](https://github.com/AlexNtrx/pos-restaurant-nextjs)
- [Backend v2.0.0 release](https://github.com/AlexNtrx/pos-restaurant-backend/releases/tag/v2.0.0)
- [Frontend v2.0.0 release](https://github.com/AlexNtrx/pos-restaurant-nextjs/releases/tag/v2.0.0)

## Release status

`v2.0.0` is a published source release. Project records include automated checks and browser verification for multiple workflows against disposable PostgreSQL. Production deployment checks and pilot acceptance remain outstanding.

## Capabilities

- JWT authentication with active-account verification and `admin`, `user`, `waiter`, and `kitchen` roles.
- Catalog, staff, and restaurant settings management with validated image uploads.
- Shared `COUNTER`, `QR`, and `STAFF` orders with immutable item/price snapshots and versioned history.
- Table sessions, QR tokens, QR modes, and public customer APIs.
- Staff inbox, kitchen actions, waiter ordering/serving, and service calls.
- Counter dine-in/takeaway checkout, table-session settlement, PDF receipts, cancellation audit, and reports.

## Requirements

Node.js and npm compatible with `package-lock.json`, PostgreSQL, and appropriate database permissions. The API uses Express 5, Prisma 5, JWT, and PDFKit. An active admin account is needed for management operations; see initial setup below.

## Install and configure

```bash
git clone https://github.com/AlexNtrx/pos-restaurant-backend.git
cd pos-restaurant-backend
npm ci
```

To use the published source, run `git checkout v2.0.0` before installing dependencies.

Create `.env` in the repository root with your own values:

```dotenv
DATABASE_URL=postgresql://USERNAME:PASSWORD@localhost:5432/db_next_workshop_pos?schema=public
SECRET_KEY=REPLACE_WITH_A_RANDOM_JWT_SECRET
QR_TOKEN_SECRET=REPLACE_WITH_64_HEXADECIMAL_CHARACTERS
```

These are placeholders, not working credentials. URL-encode special characters in database credentials. `.env` is ignored by Git.

| Variable                         | Purpose                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                   | PostgreSQL connection used by Prisma                                                                                                                         |
| `SECRET_KEY`                     | Signs and verifies staff JWTs                                                                                                                                |
| `QR_TOKEN_SECRET`                | Separate, stable QR key; exactly 64 hexadecimal characters                                                                                                   |
| `ORD02_COUNTER_CHECKOUT_ENABLED` | Optional legacy checkout bridge toggle; enabled unless exactly `false`. It does not disable browser-draft checkout or settlement of existing counter orders. |

Generate independent secret values by running this once for each secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Store the values securely. Do not use the fixed QR key from tests in deployment. Keep the QR key stable across deployments so existing session tokens can be reconstructed.

## Database and initial setup

```bash
npx prisma generate
npx prisma validate
```

For a new, disposable local development database, create the PostgreSQL database named in `.env`. After confirming `DATABASE_URL` points to that disposable target, apply committed migrations:

```bash
npx prisma migrate deploy
```

For an existing database, inspect migration status and back up the target before an approved upgrade. Do not reset an existing database to bypass migration errors. Production migrations require a deployment-specific backup and upgrade plan.

There is no seed or first-admin bootstrap script. Staff creation requires an authenticated admin, so an empty database is not a sign-in-ready installation. Obtain an approved development dataset or arrange initial admin provisioning with the maintainer. No default username or password is provided.

With an active admin, use the frontend to configure restaurant details, catalog, staff, and tables. QR ordering also requires an open table session, valid token, and appropriate QR mode.

## Run locally

Run from the repository root so environment and upload paths resolve correctly:

```bash
node server.js
```

The direct entry point listens on port `3001`. There are no `npm run dev` or `npm start` scripts. Update older commands pointing to `src/server.js`. The frontend's local API origin is `http://localhost:3001`; API routes are under `/api`.

## API overview and access

Staff requests use `Authorization: Bearer <token>`. Public QR endpoints use the session token in the URL. This table is an overview, not a full request/response specification.

| Area                      | Representative routes                                                                                   | Access                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Sign-in                   | `POST /api/user/signIn`                                                                                 | Public                                            |
| Staff management          | `/api/user/list`, `/api/user/create`, `/api/user/update`                                                | Admin                                             |
| Catalog                   | `/api/food/*`, `/api/foodtype/*`, `/api/foodSize/*`, `/api/taste/*`                                     | Management is admin-only; sale access is separate |
| Counter                   | `/api/counterOrder/*`, `/api/saleTemp/*`                                                                | Admin, user; ownership checks apply               |
| Tables                    | `GET /api/tables`, `POST /api/tables/:tableId/sessions`                                                 | Admin, user, waiter; table CRUD is admin-only     |
| QR mode/tokens            | `/api/qr-mode`, `/api/table-sessions/:sessionId/qr`                                                     | Admin, user; changing mode is admin-only          |
| Customer QR               | `/api/qr/:token/context`, `/api/qr/:token/menu`, `/api/qr/:token/orders`, `/api/qr/:token/service-call` | Valid session token                               |
| Order reads               | `GET /api/orders`, `GET /api/orders/:orderId`                                                           | Admin, user, waiter, kitchen                      |
| Order actions             | `/api/orders/:orderId/status`, `/api/orders/:orderId/serve`                                             | Admin, user, waiter; action rules apply           |
| Kitchen                   | `PATCH /api/kitchen/orders/:orderId/status`                                                             | Admin, user, kitchen                              |
| Waiter                    | `/api/waiter/menu`, `/api/waiter/orders`                                                                | Admin, user, waiter                               |
| Service calls             | `/api/service-calls`, `/api/service-calls/:callId/status`                                               | Admin, user, waiter                               |
| Table payment             | `POST /api/table-sessions/:sessionId/settle`                                                            | Admin, user                                       |
| Dashboard, bills, reports | `/api/dashboard/operations`, `/api/billSale/list`, `/api/report/*`                                      | Admin                                             |

Waiters cannot perform payments. Server-side action rules also check the role, state, object scope, and expected version.

### Kitchen staff access

Admins can create or edit `kitchen` accounts through `/api/user/create` and `/api/user/update`. The frontend displays this role as **Keittiöhenkilökunta** under **Henkilöstö** and restricts these accounts to the **Keittiö** page after sign-in.

This role can read `GET /api/orders` and `GET /api/orders/:orderId` using the existing DTOs and filters for queue loading and polling. Read access also includes statuses outside the kitchen queue. Status changes are limited to `CONFIRMED → PREPARING → READY` through `PATCH /api/kitchen/orders/:orderId/status`, with `expectedVersion` checks and recorded history.

Kitchen staff cannot confirm, reject, cancel, or serve orders; create orders; process payments; or manage tables, QR settings, service calls, the catalog, reports, or staff accounts. The backend checks the active account and current database role even when the JWT contains an outdated role claim. Existing `admin/user/waiter` permissions remain unchanged. No new migration is required because `User.level` is a String.

## Order and payment rules

- QR orders normally progress through `SUBMITTED → CONFIRMED → PREPARING → READY → SERVED`; rejection applies to submitted orders under domain rules.
- Waiter orders use `STAFF`, require an open table session, and are confirmed for kitchen work on submission.
- New counter checkout records payment and creates a confirmed kitchen order atomically. Prepaid standalone counter orders complete after serving.
- Older unpaid counter orders retain settlement. New unpaid counter submissions return `PAYMENT_REQUIRED`; exact retries of previously committed submissions can replay their result.
- Table settlement requires payable session orders to be served, creates at most one bill, completes orders, and closes the session atomically.
- The server derives financial values. Client totals and versions are assertions to check.
- Exact retries use the same idempotency key and payload. Conflicting reuse and stale versions are rejected.
- Orders cannot be cancelled after payment. Admin bill cancellation records audit information and is not a refund.
- Reports use active `BillSale` records. Bill-history dates use `Europe/Helsinki`; daily/monthly report aggregation uses UTC.

## Testing

Tests write fixtures and must run only against an approved disposable environment. The bootstrap replaces the database name with `db_next_workshop_pos_test` before loading Prisma; it does not create a separate server.

With `.env` configured for the intended local PostgreSQL server:

```bash
npm run test:db:prepare
npm run test:db:validate
npm test
npm run format:check
```

`test:db:prepare` connects to the server's `postgres` maintenance database, creates the disposable database if missing, and applies migrations to it. Its user needs those permissions. Tests reuse the configured server and credentials with the test database name. Confirm the server is approved for testing before running these commands. The bootstrap supplies a fixed test-only QR key.

`npm run migrate:passwords` is a separate data operation, not a test or mandatory setup step. It changes stored passwords and requires an approved target and backup plan.

## Deployment

Deploy matching frontend/backend versions with required migrations applied. Configure secrets, backup, persistent upload storage, HTTPS, and monitoring for the chosen environment. The server currently uses `cors()` without an origin allowlist; review deployed access configuration during rollout.

Begin with QR `DISABLED`, verify internal `MENU_ONLY` access, then pilot `ORDERING` on selected tables after end-to-end acceptance. Verify actual API reachability, payment retries, receipts, and session closure. A GitHub release does not deploy the API or database.

## Project structure

| Directory/file | Responsibility                                           |
| -------------- | -------------------------------------------------------- |
| `server.js`    | Express setup and routes                                 |
| `controller/`  | HTTP handlers                                            |
| `middleware/`  | Authentication and authorization                         |
| `lib/`         | Domain services, pricing, persistence, uploads, receipts |
| `prisma/`      | Schema and migrations                                    |
| `scripts/`     | Test database preparation and password migration         |
| `test/`        | Integration tests and database guard                     |
| `uploads/`     | Runtime uploaded media; ignored by Git                   |

## Known limits

- Single restaurant; no multi-tenancy.
- One bill per table session; no split or partial settlement.
- Polling updates; no realtime delivery.
- No JWT refresh or token revocation system.
- No customer accounts, online payments, delivery, inventory, reservations, or loyalty.
- Upload retention, unused staged images, and historical financial reconciliation need explicit operational policies.

## Workspace documentation

The combined workspace maintains `docs/backend-handoff.md` for API/security contracts, `docs/workflow-roadmap.md` for status, `docs/plan-0.md` for product/design decisions, and `docs/implementation-log.md` for verified history. These are outside this standalone repository and are not included by cloning it alone. See the linked release notes for the public version summary.
