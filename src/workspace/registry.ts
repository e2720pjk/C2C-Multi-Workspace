import path from "node:path";
import { Workspace } from "./manager.js";
import { gitInfo } from "./git.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type WorkspaceRegistryErrorCode =
  | "UNKNOWN_WORKSPACE"
  | "DISABLED_WORKSPACE"
  | "UNAVAILABLE_WORKSPACE"
  | "AMBIGUOUS_WORKSPACE"
  | "INVALID_WORKSPACE_ID"
  | "WORKSPACE_ID_COLLISION"
  | "NO_DEFAULT_WORKSPACE";

export class WorkspaceRegistryError extends Error {
  constructor(
    public readonly code: WorkspaceRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

/** The persisted installation-level allowlist. `root` is local state only. */
export interface RegisteredWorkspace {
  workspaceId: string;
  alias: string;
  displayName: string;
  root: string;
  enabled: boolean;
  registeredAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  alias: string;
  displayName: string;
  branch: string | null;
  projectType: string | null;
  languages: string[];
  enabled: boolean;
  available: boolean;
  isDefault: boolean;
}

interface PersistedWorkspaceRegistry {
  version: 1;
  defaultWorkspaceId: string | null;
  workspaces: RegisteredWorkspace[];
}

export interface WorkspaceRegistryOptions {
  file?: string;
  /** In-memory registries are useful for embedded/test bridges. */
  persist?: boolean;
}

export const INSTALLATION_WORKSPACE_ID = "installation";

export function workspaceRegistryFile(): string {
  return path.join(getStateDir(), "workspaces.json");
}

function slugAlias(name: string, id: string): string {
  const alias = name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return alias || `workspace-${id.slice(0, 8)}`;
}

function cleanAlias(value: string | undefined, fallback: string): string {
  const alias = value?.trim();
  if (!alias) return fallback;
  if (alias.length > 80) throw new WorkspaceRegistryError("UNKNOWN_WORKSPACE", "Workspace alias is too long.");
  if (alias.includes("\0") || alias.includes("/") || alias.includes("\\")) {
    throw new WorkspaceRegistryError("UNKNOWN_WORKSPACE", "Workspace alias must not contain path separators.");
  }
  return alias;
}

function validRecord(value: unknown): value is RegisteredWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RegisteredWorkspace>;
  return (
    typeof record.workspaceId === "string" &&
    /^[a-f0-9]{12}$/.test(record.workspaceId) &&
    typeof record.alias === "string" &&
    typeof record.displayName === "string" &&
    typeof record.root === "string" &&
    typeof record.enabled === "boolean" &&
    typeof record.registeredAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function emptyState(): PersistedWorkspaceRegistry {
  return { version: 1, defaultWorkspaceId: null, workspaces: [] };
}

/**
 * Installation-wide registered workspace allowlist.
 *
 * Resolution reloads the file before every operation. That keeps a running
 * bridge in sync with `c2c workspace add/disable/remove` without a mutable
 * process-global current workspace and without a second admin protocol.
 */
export class WorkspaceRegistry {
  private readonly file: string;
  private readonly persist: boolean;
  private memory: PersistedWorkspaceRegistry = emptyState();

  constructor(opts: WorkspaceRegistryOptions = {}) {
    this.file = opts.file ?? workspaceRegistryFile();
    this.persist = opts.persist ?? true;
    this.reload();
  }

  private read(): PersistedWorkspaceRegistry {
    if (!this.persist) return this.memory;
    const raw = readJsonIfExists<unknown>(this.file);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
    const value = raw as Partial<PersistedWorkspaceRegistry>;
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces.filter(validRecord) : [];
    const ids = new Set<string>();
    for (const workspace of workspaces) {
      if (ids.has(workspace.workspaceId)) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_ID_COLLISION",
          `Workspace identity collision in registry: ${workspace.workspaceId}`
        );
      }
      ids.add(workspace.workspaceId);
    }
    const defaultWorkspaceId =
      typeof value.defaultWorkspaceId === "string" && ids.has(value.defaultWorkspaceId)
        ? value.defaultWorkspaceId
        : null;
    return { version: 1, defaultWorkspaceId, workspaces };
  }

  private write(state: PersistedWorkspaceRegistry): void {
    this.memory = state;
    if (this.persist) writeSecureJson(this.file, state);
  }

  reload(): void {
    this.memory = this.read();
  }

  private state(): PersistedWorkspaceRegistry {
    this.reload();
    return this.memory;
  }

  private findBySelector(
    state: PersistedWorkspaceRegistry,
    selector: string,
    opts: { allowDisabled?: boolean } = {}
  ): RegisteredWorkspace {
    const value = selector.trim();
    if (!value || value.includes("\0")) {
      throw new WorkspaceRegistryError("INVALID_WORKSPACE_ID", "Workspace selector is empty or invalid.");
    }

    const idMatches = state.workspaces.filter((workspace) => workspace.workspaceId === value);
    if (idMatches.length > 1) {
      throw new WorkspaceRegistryError("WORKSPACE_ID_COLLISION", `Workspace identity collision: ${value}`);
    }
    const matches = idMatches.length > 0 ? idMatches : state.workspaces.filter((workspace) => workspace.alias === value);
    if (matches.length === 0) {
      throw new WorkspaceRegistryError("UNKNOWN_WORKSPACE", `Unknown workspace: ${selector}`);
    }
    if (matches.length > 1) {
      throw new WorkspaceRegistryError("AMBIGUOUS_WORKSPACE", `Workspace alias is ambiguous: ${selector}`);
    }
    const workspace = matches[0];
    if (!opts.allowDisabled && !workspace.enabled) {
      throw new WorkspaceRegistryError("DISABLED_WORKSPACE", `Workspace is disabled: ${workspace.alias}`);
    }
    return workspace;
  }

  private workspaceFor(record: RegisteredWorkspace): Workspace {
    if (!record.enabled) {
      throw new WorkspaceRegistryError("DISABLED_WORKSPACE", `Workspace is disabled: ${record.alias}`);
    }
    try {
      return new Workspace(record.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkspaceRegistryError(
        "UNAVAILABLE_WORKSPACE",
        `Workspace '${record.alias}' is unavailable: ${message}`
      );
    }
  }

  /** Register a canonical root, or re-enable/update an existing registration. */
  register(rootInput: string, opts: { alias?: string; enabled?: boolean } = {}): RegisteredWorkspace {
    const workspace = new Workspace(rootInput);
    const state = this.state();
    const now = new Date().toISOString();
    const existing = state.workspaces.find((item) => item.workspaceId === workspace.id);
    if (existing && existing.root !== workspace.root) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_ID_COLLISION",
        `Workspace id ${workspace.id} maps to more than one canonical root.`
      );
    }
    const alias = cleanAlias(opts.alias, existing?.alias ?? slugAlias(workspace.name, workspace.id));
    const record: RegisteredWorkspace = {
      workspaceId: workspace.id,
      alias,
      displayName: workspace.name,
      root: workspace.root,
      enabled: opts.enabled ?? true,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      const index = state.workspaces.indexOf(existing);
      state.workspaces[index] = record;
    } else {
      state.workspaces.push(record);
    }
    if (!state.defaultWorkspaceId) state.defaultWorkspaceId = record.workspaceId;
    this.write(state);
    return { ...record };
  }

  list(): RegisteredWorkspace[] {
    const state = this.state();
    return state.workspaces.map((workspace) => ({ ...workspace }));
  }

  defaultWorkspaceId(): string | null {
    return this.state().defaultWorkspaceId;
  }

  resolve(selector?: string): Workspace {
    const state = this.state();
    let record: RegisteredWorkspace;
    if (selector !== undefined) {
      record = this.findBySelector(state, selector);
    } else if (state.defaultWorkspaceId) {
      record = this.findBySelector(state, state.defaultWorkspaceId);
    } else {
      const enabled = state.workspaces.filter((workspace) => workspace.enabled);
      if (enabled.length !== 1) {
        throw new WorkspaceRegistryError(
          "NO_DEFAULT_WORKSPACE",
          enabled.length === 0
            ? "No enabled workspace is registered."
            : "More than one workspace is registered; specify workspace or set a default."
        );
      }
      record = enabled[0];
    }
    const workspace = this.workspaceFor(record);
    if (workspace.id !== record.workspaceId) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_ID_COLLISION",
        `Workspace id changed for canonical root '${record.alias}'.`
      );
    }
    return workspace;
  }

  record(selector: string, opts: { allowDisabled?: boolean } = {}): RegisteredWorkspace {
    return { ...this.findBySelector(this.state(), selector, opts) };
  }

  setDefault(selector: string): RegisteredWorkspace {
    const state = this.state();
    const record = this.findBySelector(state, selector);
    this.workspaceFor(record);
    state.defaultWorkspaceId = record.workspaceId;
    this.write(state);
    return { ...record };
  }

  setEnabled(selector: string, enabled: boolean): RegisteredWorkspace {
    const state = this.state();
    const record = this.findBySelector(state, selector, { allowDisabled: true });
    record.enabled = enabled;
    record.updatedAt = new Date().toISOString();
    this.write(state);
    return { ...record };
  }

  remove(selector: string): RegisteredWorkspace {
    const state = this.state();
    const record = this.findBySelector(state, selector, { allowDisabled: true });
    state.workspaces = state.workspaces.filter((workspace) => workspace.workspaceId !== record.workspaceId);
    if (state.defaultWorkspaceId === record.workspaceId) {
      const next = state.workspaces
        .filter((workspace) => workspace.enabled)
        .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.workspaceId.localeCompare(b.workspaceId))[0];
      state.defaultWorkspaceId = next?.workspaceId ?? null;
    }
    this.write(state);
    return { ...record };
  }

  summaries(): WorkspaceSummary[] {
    const state = this.state();
    return state.workspaces.map((record) => {
      let available = false;
      let projectType: string | null = null;
      let languages: string[] = [];
      let branch: string | null = null;
      try {
        const workspace = new Workspace(record.root);
        available = true;
        const project = workspace.detectProject();
        projectType = project.projectType;
        languages = project.languages;
        branch = gitInfo(workspace.root).branch;
      } catch {
        // Keep unavailable registrations visible so the user can repair/remove them.
      }
      return {
        workspaceId: record.workspaceId,
        alias: record.alias,
        displayName: record.displayName,
        branch,
        projectType,
        languages,
        enabled: record.enabled,
        available,
        isDefault: state.defaultWorkspaceId === record.workspaceId,
      };
    });
  }
}
