import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import "dotenv/config";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Export the db instance so we can use it in our auth router and tools!
export const db = drizzle(pool, { schema });
