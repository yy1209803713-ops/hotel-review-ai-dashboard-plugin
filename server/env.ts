import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export function loadLocalEnvFiles(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const shellKeys = new Set(Object.keys(env));
  for (const envFileName of ['.env', '.env.local']) {
    const envFilePath = resolve(cwd, envFileName);
    if (!existsSync(envFilePath)) {
      continue;
    }

    const raw = readFileSync(envFilePath, 'utf8');
    for (const [key, value] of Object.entries(parseEnv(raw))) {
      if (!shellKeys.has(key)) {
        env[key] = value;
      }
    }
  }
}
