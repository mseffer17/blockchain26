import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ApiError, bigintReplacer } from '@rutli/sdk';
import { PORTS, POSTE_PARTNER_KEY, SWISSQUOTE_INTERNAL_KEY, type ServiceName } from './config';
import { logger } from './log';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function createApp(service: ServiceName) {
  const app = express();
  app.set('json replacer', bigintReplacer);
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.get('/health', (_req, res) => {
    res.json({ service, ok: true, mocked: service !== 'watchtower', time: Date.now() });
  });
  return app;
}

export function start(app: express.Express, service: ServiceName, banner: string) {
  const log = logger(service);
  // Error handler (Express 5 forwards rejected promises here).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    if (err instanceof ApiError) {
      // An upstream institution refused: pass its answer through (e.g. La Poste's 409).
      const body = (err.body ?? {}) as { details?: unknown; checks?: unknown };
      res.status(err.status).json({ error: err.message, details: body.details, checks: body.checks });
      return;
    }
    log.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  const port = PORTS[service];
  app.listen(port, () => log.info(`${banner} — listening on http://localhost:${port}`));
  return log;
}

/** Swissquote-internal endpoints (service-to-service). */
export function requireInternal(req: Request) {
  if (req.header('x-sq-internal-key') !== SWISSQUOTE_INTERNAL_KEY) throw new HttpError(403, 'internal endpoint');
}

/** Partner endpoints at La Poste (called by Swissquote). */
export function requirePartner(req: Request) {
  if (req.header('x-partner-key') !== POSTE_PARTNER_KEY) throw new HttpError(403, 'partner endpoint');
}

export function bearer(req: Request): string {
  const h = req.header('authorization') ?? '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'missing session token');
  return h.slice(7);
}
