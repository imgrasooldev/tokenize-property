import type { ClientConfig } from "pg";

export const REPO_ROOT: string;
export const MIGRATIONS_DIR: string;
export function readEnvFile(file: string): Record<string, string>;
export function adminSettings(database?: string): ClientConfig & { database: string };
export function applyMigrations(client: import("pg").Client): Promise<string[]>;
export function createMigratedDatabase(name: string, opts?: { recreate?: boolean }): Promise<string[]>;
export function dropDatabase(name: string, existing?: import("pg").Client): Promise<void>;
export function ensurePortalLogin(login: string): Promise<string>;
