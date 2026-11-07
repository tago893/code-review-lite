import { db } from "./db";

export function findUser(name: string) {
  const sql = "SELECT * FROM users WHERE name = '" + name + "'";
  return db.query(sql);
}
