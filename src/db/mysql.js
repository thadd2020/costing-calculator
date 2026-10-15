// MySQL driver (mysql2), used in production on SiteGround.
import mysql from 'mysql2/promise';

// Migration files hold several statements; run them one at a time rather than enabling
// multipleStatements on the connection. Our migrations never put ';' inside a string.
function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

function wrap(conn) {
  return {
    // query() substitutes ? placeholders with escaped values (still parameterised; no string building).
    all: async (sql, params = []) => (await conn.query(sql, params))[0],
    get: async (sql, params = []) => (await conn.query(sql, params))[0][0],
    run: async (sql, params = []) => {
      const [res] = await conn.query(sql, params);
      return { insertId: res.insertId, changes: res.affectedRows };
    },
    exec: async (sql) => {
      for (const statement of splitStatements(sql)) await conn.query(statement);
    },
  };
}

export function createMysql({ host, port, user, password, database }) {
  const pool = mysql.createPool({
    host, port, user, password, database,
    connectionLimit: 5,
    charset: 'utf8mb4',
    dateStrings: true, // dates are stored as ISO text; never let the driver shift time zones
    supportBigNumbers: true,
  });
  const direct = wrap(pool);

  return {
    client: 'mysql',
    ...direct,
    transaction: async (fn) => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(wrap(conn));
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}
