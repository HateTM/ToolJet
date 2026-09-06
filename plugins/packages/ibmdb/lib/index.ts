import { ConnectionTestResult, QueryService, QueryResult, QueryError, isEmpty } from '@tooljet-plugins/common';
import { SourceOptions, QueryOptions } from './types';

// ibm_db is a native C++ addon whose bundled clidriver does not load on every
// platform we ship (e.g. it needs a newer glibc than debian bullseye provides).
// The server eagerly imports every connector through @tooljet/plugins/dist/server,
// so a top-level require here would take down server boot for everyone, DB2 user
// or not. Resolve it lazily instead, and surface the load failure as a normal
// query error on the DB2 data source only.
let ibmdbModule: any;

function getIbmdb(): any {
  if (ibmdbModule) return ibmdbModule;
  try {
    ibmdbModule = require('ibm_db');
  } catch (err: any) {
    throw new QueryError(
      'IBM DB2 driver could not be loaded',
      err?.message || 'The ibm_db native driver is not available on this platform',
      {}
    );
  }
  return ibmdbModule;
}

export default class Db2QueryService implements QueryService {
  async run(
    sourceOptions: SourceOptions,
    queryOptions: QueryOptions,
    _dataSourceId: string,
    _dataSourceUpdatedAt: string
  ): Promise<QueryResult> {
    let conn: any;
    try {
      conn = await this.openConnection(sourceOptions);
      const { query, query_params } = queryOptions;
      const finalQuery = this.hasQueryParams(query_params)
        ? this.substituteParams(query, this.sanitizeParams(query_params))
        : query;
      const rows = await this.executeQuery(conn, finalQuery);
      return { status: 'ok', data: rows };
    } catch (err: any) {
      throw new QueryError('Query could not be completed', err.message || 'An unknown error occurred', {
        sqlcode: err.sqlcode ?? null,
        state: err.state ?? null,
      });
    } finally {
      if (conn) await this.safeClose(conn);
    }
  }

  async testConnection(sourceOptions: SourceOptions): Promise<ConnectionTestResult> {
    let conn: any;
    try {
      conn = await this.openConnection(sourceOptions);
      await this.executeQuery(conn, 'SELECT 1 FROM SYSIBM.SYSDUMMY1');
      return { status: 'ok' };
    } catch (err: any) {
      throw new QueryError('Connection test failed', err.message || 'An unknown error occurred', {
        sqlcode: err.sqlcode ?? null,
        state: err.state ?? null,
      });
    } finally {
      if (conn) await this.safeClose(conn);
    }
  }

  private buildConnectionString(sourceOptions: SourceOptions): string {
    const { host, port, database, username, password } = sourceOptions;
    const parts: string[] = [
      `HOSTNAME=${host}`,
      `PORT=${port || 50000}`,
      `PROTOCOL=TCPIP`,
      `UID=${username}`,
      `PWD=${password || ''}`,
    ];
    // DATABASE is optional — DB2 z/OS does not require it; DB2 LUW typically does
    if (database && database.trim() !== '') {
      parts.unshift(`DATABASE=${database.trim()}`);
    }
    return parts.join(';') + ';';
  }

  private openConnection(sourceOptions: SourceOptions): Promise<any> {
    const ibmdb = getIbmdb();
    const connStr = this.buildConnectionString(sourceOptions);
    return new Promise((resolve, reject) => {
      ibmdb.open(connStr, (err: any, conn: any) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });
  }

  private executeQuery(conn: any, query: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      conn.query(query, (err: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  // Best-effort close — never throws so it cannot mask a query error
  private safeClose(conn: any): Promise<void> {
    return new Promise((resolve) => {
      try {
        conn.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private hasQueryParams(query_params?: string[][]): boolean {
    if (!query_params || query_params.length === 0) return false;
    return query_params.some(([key]) => !isEmpty(key));
  }

  private sanitizeParams(query_params?: string[][]): Record<string, any> {
    return Object.fromEntries((query_params || []).filter(([key]) => !isEmpty(key)));
  }

  // Replaces :paramName placeholders with safely-escaped literal values.
  // ibm_db supports only positional ? binding, not named parameters, so we
  // substitute before the query is sent to the driver.
  private substituteParams(query: string, params: Record<string, any>): string {
    return query.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
      if (!(name in params)) return match;
      const val = params[name];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return String(val);
      if (typeof val === 'boolean') return val ? '1' : '0';
      return `'${String(val).replace(/'/g, "''")}'`;
    });
  }
}
