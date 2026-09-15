import path from "node:path";
import { randomBytes } from "node:crypto";
import { acquireStateLock } from "./lock.js";
import { getStateDir, readJsonStrict, writeSecureJson } from "./paths.js";

export interface InstallationIdentity {
  version: 1;
  installationId: string;
  createdAt: string;
  /** Last bound port is only a diagnostic hint for missing-runtime detection. */
  lastPort?: number;
}

export class InstallationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationStateError";
  }
}

export function installationIdentityFile(): string {
  return path.join(getStateDir(), "installation.json");
}

function validIdentity(value: unknown): value is InstallationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Partial<InstallationIdentity>;
  return (
    identity.version === 1 &&
    typeof identity.installationId === "string" &&
    /^c2c_inst_[A-Za-z0-9_-]{16,}$/.test(identity.installationId) &&
    typeof identity.createdAt === "string" &&
    (identity.lastPort === undefined ||
      (Number.isInteger(identity.lastPort) && identity.lastPort > 0 && identity.lastPort <= 65535))
  );
}

export function readInstallationIdentity(): InstallationIdentity | null {
  let value: unknown;
  try {
    value = readJsonStrict<unknown>(installationIdentityFile());
  } catch {
    throw new InstallationStateError("C2C installation identity is corrupt; refusing to create a new identity.");
  }
  if (value === null) return null;
  if (!validIdentity(value)) {
    throw new InstallationStateError("C2C installation identity is invalid; refusing to create a new identity.");
  }
  return value;
}

/** Atomically create the one persistent identity shared by all workspaces. */
export function ensureInstallationIdentity(): InstallationIdentity {
  const file = installationIdentityFile();
  const lock = acquireStateLock(`${file}.lock`);
  try {
    const existing = readInstallationIdentity();
    if (existing) return existing;
    const identity: InstallationIdentity = {
      version: 1,
      installationId: `c2c_inst_${randomBytes(18).toString("base64url")}`,
      createdAt: new Date().toISOString(),
    };
    writeSecureJson(file, identity);
    return identity;
  } finally {
    lock.release();
  }
}

/** Record the last listener port without changing the stable installation id. */
export function rememberInstallationPort(port: number): InstallationIdentity {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid installation port.");
  const file = installationIdentityFile();
  const lock = acquireStateLock(`${file}.lock`);
  try {
    const existing = readInstallationIdentity();
    const identity = existing ?? {
      version: 1 as const,
      installationId: `c2c_inst_${randomBytes(18).toString("base64url")}`,
      createdAt: new Date().toISOString(),
    };
    const next = { ...identity, lastPort: port };
    writeSecureJson(file, next);
    return next;
  } finally {
    lock.release();
  }
}
