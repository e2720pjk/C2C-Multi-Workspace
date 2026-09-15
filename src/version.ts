import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.3";
export const SERVICE_NAME = "c2c-bridge";
export const PRODUCT_NAME = "Codex with ChatGPT";
/** Bump when the persisted daemon/runtime protocol is no longer reusable. */
export const RUNTIME_CONTRACT_ID = "c2c-installation-v2";

function implementationId(): string {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:ts|js)$/.test(entry.name)) files.push(full);
    }
  };
  try {
    visit(moduleRoot);
  } catch {
    // A partial source/build checkout can still report a deterministic fallback id.
  }
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(moduleRoot, file));
    hash.update(fs.readFileSync(file));
  }
  const packageFile = path.join(moduleRoot, "..", "package.json");
  if (fs.existsSync(packageFile)) hash.update(fs.readFileSync(packageFile));
  return `c2c-build-${hash.digest("hex").slice(0, 16)}`;
}

/** Fingerprint of the actually executing source/build tree; package version alone is not a reuse proof. */
export const RUNTIME_BUILD_ID = implementationId();
