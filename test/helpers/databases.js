// Test databases. SQLite (in memory) always; MySQL too when TEST_MYSQL_URL is set, e.g.
//   TEST_MYSQL_URL=mysql://root:password@127.0.0.1:33306 npm test
// Each MySQL test gets its own throwaway database, dropped afterwards.
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { openDb, migrate } from '../../src/db/index.js';

const MYSQL_URL = process.env.TEST_MYSQL_URL;

function mysqlServerConfig() {
  const u = new URL(MYSQL_URL);
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

// Returns [{ name, create }] where create() resolves to { db, cleanup }.
export function testDatabases() {
  const list = [{
    name: 'sqlite',
    create: async ({ migrated = true } = {}) => {
      const db = openDb({ client: 'sqlite', file: ':memory:' });
      if (migrated) await migrate(db);
      return { db, cleanup: () => db.close() };
    },
  }];
  if (MYSQL_URL) {
    list.push({
      name: 'mysql',
      create: async ({ migrated = true } = {}) => {
        const server = mysqlServerConfig();
        const database = `gp_test_${crypto.randomBytes(4).toString('hex')}`;
        const admin = await mysql.createConnection(server);
        await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
        const db = openDb({ client: 'mysql', ...server, database });
        if (migrated) await migrate(db);
        return {
          db,
          cleanup: async () => {
            await db.close();
            await admin.query(`DROP DATABASE \`${database}\``);
            await admin.end();
          },
        };
      },
    });
  }
  return list;
}
