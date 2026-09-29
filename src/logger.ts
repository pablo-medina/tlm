import { pino, type DestinationStream, type Logger } from 'pino';
import type { LoggingConfig } from './config/schema.js';
import type { SecretScrubber } from './redact.js';

/**
 * Creates the service logger. Every serialized line goes through `scrubber`, so credentials from the
 * configuration never reach the output. `destination` is for tests; it disables pretty printing.
 */
export function createLogger(
  config: LoggingConfig,
  scrubber: SecretScrubber,
  destination?: DestinationStream,
): Logger {
  const options = {
    level: config.level,
    base: { service: 'tlm' },
    redact: {
      paths: [
        'headers.authorization',
        '*.headers.authorization',
        'apiKey',
        '*.apiKey',
        '*.*.apiKey',
      ],
      censor: '[redacted]',
    },
    hooks: { streamWrite: (line: string) => scrubber.scrub(line) },
  };
  if (destination) return pino(options, destination);
  return pino({
    ...options,
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
