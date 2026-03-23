import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts", // Make sure this matches where you put your schema!
  out: "./drizzle", // Where migration files will be saved
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
