import path from "node:path";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  const apiKey = env.MD_API_KEY ?? "";
  if (apiKey.length < 32 || /[\s\x00-\x1f\x7f]/.test(apiKey)) throw new Error("MD_API_KEY must contain at least 32 non-whitespace characters");
  const port = integer("MD_PORT", 8000);
  if (port > 65535) throw new Error("MD_PORT must be at most 65535");
  const publicUrl = new URL(env.MD_PUBLIC_BASE_URL ?? `http://localhost:${port}`);
  if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("MD_PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, query or path");
  const publicBaseUrl = publicUrl.origin;
  const allowedHosts = env.MD_ALLOWED_HOSTS?.split(",").map(value => value.trim()).filter(Boolean) ?? [publicUrl.host, `localhost:${port}`, `127.0.0.1:${port}`];
  if (!allowedHosts.length || allowedHosts.some(host => /[\s\/\\?#@]/.test(host))) throw new Error("MD_ALLOWED_HOSTS must contain comma-separated Host header values");
  return {
    apiKey, publicBaseUrl, allowedHosts, port, host: env.MD_HOST ?? "127.0.0.1",
    jobs: {
      dataDir: path.resolve(env.MD_DATA_DIR ?? "./data"),
      maxUploadBytes: integer("MD_MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
      maxStorageBytes: integer("MD_MAX_STORAGE_BYTES", 256 * 1024 * 1024),
      maxJobs: integer("MD_MAX_JOBS", 100),
      retentionMs: integer("MD_RETENTION_MS", 24 * 60 * 60 * 1000),
      uploadTtlMs: integer("MD_UPLOAD_TTL_MS", 15 * 60 * 1000),
      conversionTimeoutMs: integer("MD_CONVERSION_TIMEOUT_MS", 120_000),
      maxOutputBytes: integer("MD_MAX_OUTPUT_BYTES", 25 * 1024 * 1024),
      concurrency: integer("MD_CONCURRENCY", 2),
    },
  };
}
