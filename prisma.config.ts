import { defineConfig } from "prisma/config";
import { readConfig } from "./src/foundation/environment.ts";

const { database } = readConfig(process.env, "migration");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: database.url },
});
