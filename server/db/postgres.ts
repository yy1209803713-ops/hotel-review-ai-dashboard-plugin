import { Pool } from 'pg';

export function requireDatabaseUrl(env: { DATABASE_URL?: string } = process.env): string {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return databaseUrl;
}

export function createPostgresPool(databaseUrl = requireDatabaseUrl()): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
}
