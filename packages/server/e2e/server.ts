import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "mimir-web-e2e-"));
process.env.NODE_ENV = "test";
process.env.MIMIR_PORT = "4173";
process.env.MIMIR_HOST = "127.0.0.1";
process.env.MIMIR_DB_PATH = join(directory, "mimir.sqlite");
process.env.MIMIR_LOG_FILE = join(directory, "mimir.log");
process.env.AUTH_ENABLED = "true";
process.env.AUTH_BASE_URL = "http://localhost:4173";
process.env.AUTH_DB_PATH = join(directory, "auth.sqlite");
process.env.AUTH_SECRET = "mimir-playwright-secret-at-least-thirty-two-bytes";
process.env.AUTH_SETUP_TOKEN = "mimir-playwright-setup";

await import("../src/index");
