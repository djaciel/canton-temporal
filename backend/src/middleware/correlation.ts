// =============================================================================
// Correlation ID Middleware
//
// Reads X-Correlation-Id from the incoming request header. If absent, generates
// a new UUID. Attaches the value to req.correlationId and sets it on the
// response header so callers can trace the request.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}
