import type { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';

type Source = 'body' | 'params' | 'query';

// Validate a request part against a Zod schema. On failure, responds with the
// project's standard 400 shape — { error: 'validation_error', details: [{ field, message }] }
// — which the webapp already parses (see readError in research-requests-api.ts).
// On success, the parsed (trimmed/coerced) value is written back onto the request
// so controllers consume clean data.
//
// Mount AFTER auth/ban guards so unauthenticated or banned callers still get
// their 401/403 before any field-level feedback.
export function validate(schema: ZodType, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.length ? issue.path.join('.') : source,
        message: issue.message,
      }));
      res.status(400).json({ error: 'validation_error', details });
      return;
    }
    // req.query is a getter-only in Express 5; body/params are writable.
    if (source === 'query') {
      Object.assign(req.query as Record<string, unknown>, result.data);
    } else {
      req[source] = result.data as never;
    }
    next();
  };
}
