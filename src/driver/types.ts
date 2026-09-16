// ProjectDriver — the swappable boundary between the supervisor and a
// virtualization backend (docs/research/01, decision #3).
// Implementations: container.ts (Apple container CLI, macOS — done),
// driver/kvm (Cloud Hypervisor REST, Linux — future).

export interface DriverCapabilities {
  snapshot: boolean;
  sharedMount: boolean;
  routableIp: boolean;
}

export interface ProjectInfo {
  ref: string;             // driver-native id (container name)
  state: "running" | "stopped" | "unknown";
  address?: string;        // guest IP if routable
  cpus?: number;           // configured vCPUs
  memoryLimitBytes?: number;
}

export interface ProjectStats {
  cpuUsageUsec?: number;   // cumulative — sample twice for a percentage
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  numProcesses?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  blockReadBytes?: number;
  blockWriteBytes?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TerminalHandle {
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onExit(cb: () => void): void;
}

export interface ProjectDriver {
  readonly name: string;
  readonly capabilities: DriverCapabilities;

  create(ref: string, image: string, opts?: { cpus?: number; memoryMB?: number; diskGB?: number }): Promise<void>;
  destroy(ref: string): Promise<void>;
  inspect(ref: string): Promise<ProjectInfo>;
  list(): Promise<ProjectInfo[]>;
  /** Live resource usage, or null if unavailable. */
  stats(ref: string): Promise<ProjectStats | null>;

  /** Run a command in the guest, capture output. */
  exec(ref: string, cmd: string[], opts?: { user?: string }): Promise<ExecResult>;
  /** Run a shell snippet in the guest with a byte stream piped to stdin. */
  execWithStdin(ref: string, shellCmd: string, stdin: Blob | Uint8Array): Promise<ExecResult>;
  /** Run a shell snippet in the guest and stream stdout back as bytes. */
  execCaptureBytes(ref: string, shellCmd: string): Promise<{ exitCode: number; stdout: Uint8Array }>;
  /** Interactive PTY attached to a command in the guest (the terminal bridge). */
  terminal(ref: string, cmd: string[], size: { cols: number; rows: number }): TerminalHandle;
}
