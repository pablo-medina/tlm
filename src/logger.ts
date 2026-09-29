import { pino, type Logger } from 'pino';
import type { LoggingConfig } from './config/schema.js';

export function createLogger(config: LoggingConfig): Logger {
  return pino({
    level: config.level,
    base: { service: 'tlm' },
    redact: {
      paths: ['headers.authorization', 'req.headers.authorization', '*.apiKey'],
      censor: '[redacted]',
    },
    transport: config.pretty
      ? {
          target: 'pino-pretty',
          options: {
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service',
            singleLine: true,
          },
        }
      : undefined,
  });
}
