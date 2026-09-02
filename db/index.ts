import { drizzle } from "drizzle-orm/libsql";

import { getLocalClient } from "./local-sqlite";
import * as schema from "./schema";

export function getDb() {
  return drizzle(getLocalClient(), { schema });
}
