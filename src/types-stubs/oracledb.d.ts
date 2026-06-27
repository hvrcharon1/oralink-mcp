// Minimal ambient stub for oracledb v6 (no @types/oracledb available).
// Keeps strict TypeScript happy without changing runtime behavior.
declare namespace oracledb {
  type BindParameters = Record<string, any> | any[];

  interface PoolAttributes { [k: string]: any }

  interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }

  interface Connection {
    execute<T = any>(sql: string, binds?: BindParameters, opts?: any): Promise<{
      rows?: T[];
      metaData?: Array<{ name: string }>;
      rowsAffected?: number;
      outBinds?: any;
    }>;
    close(): Promise<void>;
  }

  const OUT_FORMAT_OBJECT: number;
  const CLOB: number;
  const NCLOB: number;
  const STRING: number;
  const NUMBER: number;
  const BIND_OUT: number;

  /** true when running in thin (pure-JS) mode */
  const thin: boolean;

  let fetchAsString: number[];

  function createPool(attrs: PoolAttributes): Promise<Pool>;
}

declare module 'oracledb' {
  export = oracledb;
}
