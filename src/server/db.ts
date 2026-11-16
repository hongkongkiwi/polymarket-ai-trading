import type { SqlDb } from "./lib/paper-ledger";

export type DB = D1Database;

export function createDb(binding: DB): SqlDb {
  const prepare = (sql: string, params: unknown[] = []) => binding.prepare(sql).bind(...params);
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await prepare(sql, params).all<T>();
      return result.results;
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
      return (await prepare(sql, params).first<T>()) ?? undefined;
    },
    async run(sql: string, params?: unknown[]): Promise<unknown> {
      return prepare(sql, params).run();
    },
  };
}
