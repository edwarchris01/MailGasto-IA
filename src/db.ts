import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import { Pool, PoolClient } from 'pg';
import { CONFIG, Config } from './config.js';

@Injectable()
export class Database implements OnApplicationShutdown {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 3000 });
    this.pool.on('error', () => console.error('Idle PostgreSQL connection failed'));
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []) {
    return this.pool.query<T>(sql, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate() {
    const files = (await readdir('db')).filter(name => name.endsWith('.sql')).sort();
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(192768049)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
      for (const name of files) {
        const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
        if (existing.rowCount) continue;
        await client.query(await readFile('db/' + name, 'utf8'));
        await client.query('INSERT INTO schema_migrations VALUES ($1)', [name]);
      }
    });
  }

  onApplicationShutdown() {
    return this.pool.end();
  }
}
