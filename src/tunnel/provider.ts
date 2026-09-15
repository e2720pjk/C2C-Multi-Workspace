/**
 * Tunnel abstraction. Business logic never talks to a specific vendor;
 * it only sees this interface. Providers may expose a public URL (Cloudflare)
 * or use an existing control-plane identity without one (OpenAI Secure Tunnel).
 */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  detail?: string;
  /** False when the provider process is alive but its local MCP authorization is unusable. */
  authorizationHealthy?: boolean;
  /** Expiry of the current internal authorization; never the token itself. */
  authorizationExpiresAt?: number;
}

export interface TunnelDoctorReport {
  provider: string;
  binaryFound: boolean;
  binaryPath: string | null;
  running: boolean;
  url: string | null;
  problems: string[];
}

export interface TunnelProvider {
  readonly name: string;
  /** Start the tunnel for a local port; null means the provider has no public URL. */
  start(localPort: number): Promise<string | null>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<string | null>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}
