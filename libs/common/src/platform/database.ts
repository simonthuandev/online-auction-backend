export const PLATFORM_DB = Symbol('PLATFORM_DB');
export interface Database {
  query<T = Record<string, unknown>>(
    sql: string,
    ...values: unknown[]
  ): Promise<T[]>;
  execute(sql: string, ...values: unknown[]): Promise<number>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
export type Transaction = Pick<Database, 'query' | 'execute'>;
