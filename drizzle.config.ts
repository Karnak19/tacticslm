import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./shared/schema.ts",
  out: "./server/db/migrations",
  dbCredentials: { url: process.env.DATABASE_PATH ?? "data/tacticslm.db" },
  strict: true,
  verbose: true,
});
