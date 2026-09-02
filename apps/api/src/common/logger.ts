import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { Options } from 'pino-http';

/** Never let a password, token, or identity document reach the log stream. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'res.headers["set-cookie"]',
];

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino/file', options: { destination: 1 } } } : {}),
  });
}

export function httpLoggerOptions(logger: pino.Logger): Options {
  return {
    logger,
    // RequestIdMiddleware has already assigned and echoed the id; reuse it so
    // the logs and the error responses quote the same value.
    genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Health probes would otherwise dominate the log volume.
    autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
  };
}
