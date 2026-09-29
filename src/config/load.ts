import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Recursively replaces `${VAR}` and `${VAR:-default}` in every string value.
 * Throws a ConfigError listing all variables that are unset and have no default.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const missing = new Set<string>();

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
        const resolved = env[name];
        if (resolved !== undefined && resolved !== '') return resolved;
        if (fallback !== undefined) return fallback;
        missing.add(name);
        return '';
      });
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    }
    return node;
  };

  const result = visit(value);
  if (missing.size > 0) {
    throw new ConfigError(`missing environment variables: ${[...missing].join(', ')}`);
  }
  return result;
}

/** Parses and validates configuration from a YAML string. */
export function parseConfig(source: string, env: NodeJS.ProcessEnv = process.env): Config {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new ConfigError(`invalid YAML: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError('configuration must be a YAML mapping');
  }

  const result = configSchema.safeParse(interpolateEnv(raw, env));
  if (!result.success) {
    throw new ConfigError(`invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Reads, parses and validates the configuration file at `path`. */
export async function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(source, env);
}
