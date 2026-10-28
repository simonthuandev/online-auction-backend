# Working agreements

Read README.md, docs/platform-handover.md and the target service README before changing code. Six services own their own databases, generated Prisma Clients and business behavior. Do not import another app or query its database. No cross-service SQL joins or physical foreign keys.

Public/internal REST contracts live in contracts/openapi; integration events in contracts/events. Edit these sources then run npm run contracts:generate and npm run contracts:check. Do not hand-edit generated types or krakend/krakend.json. Keep backward-compatible changes additive. Coordinate breaking contract changes with both owners.

Register HTTP/event business handlers in the service-owned service-handlers.ts. Keep ownership checks in business handlers. Use the supplied event transaction for all consumer writes so ProcessedEvent rolls back with failures. Producers enqueueEvent in the same local transaction as their business write. Follow README examples; do not publish directly after committing a business write.

Keep relative TypeScript imports suffixed .js (ESM). Keep Prisma 6.4.1 and Node 24 for this baseline. Do not replace Vitest/Oxlint/Rspack or reset database volumes. Add per-service migrations; preserve historical migrations and partial indexes. Demo modules/probes are connectivity fixtures, not completed business functionality.

Validate changed service(s) with typecheck, lint and meaningful tests. Shared platform/contract changes require all six builds/typechecks and integration smoke. Integration uses a separate Compose project and env file, never resets the user's existing database. Never commit .env, .local keys, tokens or credentials. Do not add new infrastructure configuration to business handlers.
