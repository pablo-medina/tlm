import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { configSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Environment variables available to `${VAR}` placeholders. */
export type Env = NodeJS.Dict<string>;

/** `$${` is an escaped, literal `${`; otherwise `${VAR}` or `${VAR:-default}`. */
const ENV_PATTERN = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Recursively replaces `${VAR}` and `${VAR:-default}` in every string value (keys are left alone).
 * `$${...}` produces a literal `${...}`. Unset and empty variables are treated the same way.
 * Throws a ConfigError listing all variables that are unset and have no default.
 */
export function interpolateEnv(value: unknown, env: Env = process.env): unknown {
  const missing = new Set<string>();

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(
        ENV_PATTERN,
        (match, name: string | undefined, fallback: string | undefined) => {
          if (name === undefined) return '${';
          const resolved = env[name];
          if (resolved !== undefined && resolved !== '') return resolved;
          if (fallback !== undefined) return fallback;
          missing.add(name);
          return match;
        },
      );
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
export function parseConfig(source: string, env: Env = process.env): Config {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    // Keep only the first line: the rest is a source excerpt that could contain a hard-coded secret.
    const [summary] = (error as Error).message.split('\n');
    throw new ConfigError(`invalid YAML: ${summary}`);
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
export async function loadConfig(path: string, env: Env = process.env): Promise<Config> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(source, env);
}

export interface EnvFile {
  path: string;
  /** When false, a missing file is ignored. */
  required: boolean;
}

/** Reads a `.env` file (KEY=value lines). It does not modify `process.env`. */
export async function readEnvFile({ path, required }: EnvFile): Promise<Env> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`cannot read env file ${path}: ${(error as Error).message}`);
  }
  return parseEnv(source);
}

export interface ConfigSource {
  configPath: string;
  envFile: EnvFile;
}

/**
 * Loads the configuration with variables from the env file and the process environment.
 * The process environment wins, so real environment variables always override `.env` values.
 */
export async function loadConfigSource(
  source: ConfigSource,
  processEnv: Env = process.env,
): Promise<Config> {
  const fileEnv = await readEnvFile(source.envFile);
  return loadConfig(source.configPath, { ...fileEnv, ...processEnv });
}
