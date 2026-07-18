import initSqlJs from "sql.js";
import migration from "../../migrations/0001_initial.sql?raw";

export async function createSqliteD1(): Promise<D1Database> {
  const SQL = await initSqlJs();
  const database = new SQL.Database();

  const d1 = {
    prepare(query: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async run() {
          const statement = database.prepare(query);
          try {
            statement.bind(params as never[]);
            while (statement.step()) {
              // Exhaust statement.
            }
            return { success: true, meta: { changes: database.getRowsModified() } } as D1Result;
          } finally {
            statement.free();
          }
        },
        async all() {
          const statement = database.prepare(query);
          const results: Record<string, unknown>[] = [];
          try {
            statement.bind(params as never[]);
            while (statement.step()) {
              results.push(statement.getAsObject());
            }
            return { success: true, results } as unknown as D1Result;
          } finally {
            statement.free();
          }
        },
        async first(column?: string) {
          const result = await this.all();
          const first = (result.results?.[0] ?? null) as Record<string, unknown> | null;
          return column && first ? first[column] : first;
        }
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      const results: D1Result[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
    async exec(query: string) {
      database.run(query);
      return { count: 0, duration: 0 };
    },
    dump() {
      return database.export();
    }
  };

  return d1 as unknown as D1Database;
}

export async function applyMigrations(db: D1Database): Promise<void> {
  await db.exec(migration);
}
