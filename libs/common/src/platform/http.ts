import {
  HttpException,
  HttpStatus,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
  type INestApplication,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { AccessTokens, requireServiceKey, type Principal } from './security.js';
import { PLATFORM_DB, type Database } from './database.js';
import { document, validator, type IntegrationEvent } from './contracts.js';
import { PlatformRedis } from './redis.js';
import { RmqService } from '../rmq/rmq.service.js';
import { InternalHttp } from './internal-http.js';
import { HttpHandlers } from './handlers.js';
import { enqueueEvent } from './messaging.js';
export interface AuthRequest extends Request {
  principal?: Principal;
  requestId: string;
}
export function sendError(
  error: unknown,
  request: Request,
  response: Response,
) {
  let status =
    error instanceof HttpException
      ? error.getStatus()
      : (error as { status?: number })?.status === 400
        ? 400
        : (error as { status?: number })?.status === 413
          ? 413
          : 500;
  if ((error as { code?: string })?.code === 'P2002') status = 409;
  const code =
    (
      {
        400: 'INVALID_REQUEST',
        401: 'UNAUTHENTICATED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        501: 'FEATURE_NOT_IMPLEMENTED',
        502: 'UPSTREAM_UNAVAILABLE',
        503: 'DEPENDENCY_UNAVAILABLE',
      } as Record<number, string>
    )[status] || 'INTERNAL_ERROR';
  const value =
    error instanceof HttpException ? error.getResponse() : undefined;
  response.status(status).json({
    code,
    message:
      typeof value === 'object' && value && 'message' in value
        ? value.message
        : typeof value === 'string'
          ? value
          : status === 409
            ? 'Resource already exists'
            : 'Internal server error',
    requestId: (request as AuthRequest).requestId || randomUUID(),
  });
}
@Catch()
export class PlatformExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    sendError(error, ctx.getRequest(), ctx.getResponse());
  }
}
const idSchema = { type: 'string', format: 'uuid' };
const validId = validator(idSchema);
const demoAllowed = () =>
  process.env.PLATFORM_DEMO_ENABLED === 'true' &&
  ['development', 'test'].includes(process.env.NODE_ENV || '');
export function registerPlatformHttp(app: INestApplication, service: string) {
  const server = app.getHttpAdapter().getInstance();
  const db = app.get<Database>(PLATFORM_DB);
  const tokens = app.get(AccessTokens);
  const redis = app.get(PlatformRedis);
  const rmq = app.get(RmqService);
  const http = app.get(InternalHttp);
  const doc = document(service);
  const handlers = app.get(HttpHandlers);
  app.use((req: AuthRequest, res: Response, next: NextFunction) => {
    req.requestId = validId(req.headers['x-request-id'])
      ? String(req.headers['x-request-id'])
      : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    const start = Date.now();
    res.on('finish', () =>
      console.log(
        JSON.stringify({
          service,
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
        }),
      ),
    );
    next();
  });
  const route = (
    method: string,
    path: string,
    fn: (req: AuthRequest, res: Response, next: NextFunction) => unknown,
  ) =>
    server[method](
      path,
      (req: AuthRequest, res: Response, next: NextFunction) =>
        Promise.resolve()
          .then(() => fn(req, res, next))
          .catch((e) => sendError(e, req, res)),
    );
  route('get', '/health/live', (_req, res) =>
    res.json({ service, status: 'live' }),
  );
  async function health(detailed = false) {
    await db.query('SELECT 1');
    const dependencies = {
      database: 'ready',
      rabbitmq: rmq.connected ? 'ready' : 'degraded',
      redis: redis.client.status === 'ready' ? 'ready' : 'degraded',
    };
    return {
      service,
      status: Object.values(dependencies).includes('degraded')
        ? 'degraded'
        : 'ready',
      ...(detailed ? { dependencies } : {}),
    };
  }
  route('get', '/health/ready', async (req, res) => {
    try {
      res.json(await health());
    } catch {
      throw new HttpException('Database unavailable', 503);
    }
  });
  route('get', '/health/dependencies', async (req, res) => {
    requireServiceKey(
      req.headers['x-service-key'],
      process.env.PLATFORM_ADMIN_KEY,
    );
    try {
      res.json(await health(true));
    } catch {
      throw new HttpException('Database unavailable', 503);
    }
  });
  if (process.env.NODE_ENV !== 'production')
    route('get', '/openapi.json', (_req, res) => res.json(doc));
  for (const [gatewayPath, ops] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(ops)) {
      if (op['x-implementation'] === 'completed' && service !== 'auth')
        continue;
      if (op['x-backend-path'].startsWith('/health')) continue;
      const bodyCheck = op.requestBody
        ? validator(op.requestBody.content['application/json'].schema, doc)
        : undefined;
      const checks = (op.parameters || []).map((p) => ({
        ...p,
        check: validator(p.schema, doc),
      }));
      const path = op['x-backend-path'].replace(/\{([^}]+)\}/g, ':$1');
      route(method, path, async (req, res, next) => {
        if (op['x-auth'] === 'bearer')
          req.principal = tokens.authorize(
            req.headers.authorization,
            op['x-roles'],
          );
        if (op['x-auth'] === 'internal')
          requireServiceKey(
            req.headers['x-service-key'],
            service === 'product'
              ? process.env.INTERNAL_AUCTION_KEY
              : process.env.INTERNAL_PAYMENT_KEY,
          );
        if (bodyCheck && !bodyCheck(req.body))
          throw new HttpException(
            { message: 'Invalid request body', details: bodyCheck.errors },
            400,
          );
        for (const p of checks) {
          let value: unknown =
            p.in === 'path'
              ? req.params[p.name]
              : p.in === 'header'
                ? req.headers[p.name.toLowerCase()]
                : req.query[p.name];
          if (value === undefined) {
            if (p.required) throw new HttpException('Missing ' + p.name, 400);
            continue;
          }
          if (p.in === 'query' && (p.name === 'page' || p.name === 'pageSize'))
            value = Number(value);
          if (!p.check(value))
            throw new HttpException('Invalid ' + p.name, 400);
        }
        if (service === 'auth' && op['x-implementation'] === 'completed')
          return next();
        const handler = handlers.get(op.operationId);
        if (handler) {
          const result = await handler(req);
          const code = Number(
            Object.keys(op.responses).find((c) => c.startsWith('2')) || 200,
          );
          return res.status(code).json(result);
        }
        if (demoAllowed() && op['x-auth'] === 'internal') {
          const runId = validId(req.headers['x-correlation-id'])
            ? String(req.headers['x-correlation-id'])
            : req.requestId;
          const result =
            service === 'product'
              ? {
                  auctionId: req.body.auctionId,
                  productId: req.params.id,
                  sellerId: req.body.sellerId,
                  productTitle: 'Demo product',
                  productThumbnail: null,
                }
              : {
                  orderId: req.params.id,
                  buyerId: '10000000-0000-4000-8000-000000000003',
                  sellerId: '10000000-0000-4000-8000-000000000002',
                  amount: '100000',
                  currency: 'VND',
                  status: 'PENDING_PAYMENT',
                };
          await db.execute(
            'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT ("runId",kind) DO NOTHING',
            randomUUID(),
            runId,
            'internal:' + op.operationId,
            JSON.stringify(result),
          );
          return res.json(result);
        }
        throw new HttpException(
          `Business handler not implemented: ${gatewayPath}`,
          HttpStatus.NOT_IMPLEMENTED,
        );
      });
    }
  if (demoAllowed()) {
    const authorize = (req: AuthRequest) =>
      requireServiceKey(
        req.headers['x-service-key'],
        process.env.PLATFORM_ADMIN_KEY,
      );
    route('post', '/_platform/probe', async (req, res) => {
      authorize(req);
      const { runId: rawRunId, kind } = req.body || {};
      const runId = String(rawRunId || '');
      if (!validId(runId) || !['redis', 'rest', 'fault'].includes(kind))
        throw new HttpException('Invalid demo request', 400);
      let data: unknown;
      if (kind === 'redis') data = await redis.probe(runId);
      else if (kind === 'rest' && service === 'auction')
        data = await http.reserveProduct(
          '20000000-0000-4000-8000-000000000001',
          {
            auctionId: runId,
            sellerId: '10000000-0000-4000-8000-000000000002',
          },
          runId,
        );
      else if (kind === 'rest' && service === 'payment')
        data = await http.paymentContext(
          '30000000-0000-4000-8000-000000000001',
          runId,
        );
      else if (kind === 'fault') {
        if (
          ![
            'auction.started',
            'bid.placed',
            'auction.ended',
            'payment.succeeded',
          ].includes(req.body.eventName) ||
          !Number.isInteger(req.body.remaining) ||
          req.body.remaining < 0 ||
          req.body.remaining > 4
        )
          throw new HttpException('Invalid fault', 400);
        await db.execute(
          'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT ("runId",kind) DO UPDATE SET data=excluded.data',
          randomUUID(),
          runId,
          'failure:' + req.body.eventName,
          JSON.stringify({ remaining: req.body.remaining }),
        );
        data = { configured: true };
      } else
        throw new HttpException('No REST dependency for this service', 400);
      if (kind !== 'fault')
        await db.execute(
          'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT ("runId",kind) DO UPDATE SET data=excluded.data',
          randomUUID(),
          runId,
          kind,
          JSON.stringify(data),
        );
      return res.json({ demo: true, runId, service, data });
    });
    route('get', '/_platform/probes/:runId', async (req, res) => {
      authorize(req);
      if (!validId(req.params.runId))
        throw new HttpException('Invalid run ID', 400);
      res.json(
        await db.query(
          'SELECT kind,data FROM "PlatformProbe" WHERE "runId"=$1 ORDER BY kind',
          req.params.runId,
        ),
      );
    });
    if (['auction', 'payment'].includes(service))
      route('post', '/_platform/events', async (req, res) => {
        authorize(req);
        const event = req.body as IntegrationEvent;
        if (
          !event?.demo ||
          event.producer !== service ||
          event.demo.runId !== event.correlationId
        )
          throw new HttpException(
            'Demo envelope required for local producer',
            400,
          );
        try {
          await db.transaction(async (tx) => {
            await tx.execute(
              'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT ("runId",kind) DO NOTHING',
              randomUUID(),
              event.demo!.runId,
              'outgoing:' + event.eventName,
              JSON.stringify(event),
            );
            await enqueueEvent(tx, event);
          });
        } catch (e) {
          if (e instanceof Error && e.message === 'INVALID_EVENT_SCHEMA')
            throw new HttpException('Invalid event', 400);
          throw e;
        }
        res.status(202).json({ demo: true, eventId: event.eventId });
      });
  }
}
