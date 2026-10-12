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
  gateway?: string;        // the host's address on the guest's network
  network?: string;        // name of the network the guest is attached to
  isolated?: boolean;      // no network interface at all — only the host socket leads out
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

export interface ByteStream {
  write(chunk: Uint8Array): void;
  /** No more input (the guest process sees EOF on stdin). */
  end(): void;
  kill(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  /** The guest process has exited and all of its output was delivered. */
  onClose(cb: () => void): void;
}

export interface ProjectDriver {
  readonly name: string;
  readonly capabilities: DriverCapabilities;

  /** `network: "none"` boots the guest with no network interface. `socket`
   *  publishes a unix socket that a process in the guest listens on (`guest`)
   *  as a socket on the host (`host`) — the host dials in; it is the one
   *  channel a network-less guest has. */
  create(ref: string, image: string, opts?: {
    cpus?: number; memoryMB?: number; diskGB?: number; network?: string;
    socket?: { host: string; guest: string };
  }): Promise<void>;
  destroy(ref: string): Promise<void>;
  inspect(ref: string): Promise<ProjectInfo>;
  list(): Promise<ProjectInfo[]>;
  /** Live resource usage, or null if unavailable. */
  stats(ref: string, timeoutMs?: number): Promise<ProjectStats | null>;

  /** Run a command in the guest, capture output. */
  exec(ref: string, cmd: string[], opts?: { user?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Run a shell snippet in the guest with a byte stream piped to stdin. */
  execWithStdin(ref: string, shellCmd: string, stdin: Blob | Uint8Array, opts?: { user?: string }): Promise<ExecResult>;
  /** Run a shell snippet in the guest with both directions streamed: a raw
   *  byte pipe to a process in the guest (port forwards ride on this). */
  stream(ref: string, shellCmd: string): ByteStream;
  /** Run a shell snippet in the guest and stream stdout back as bytes. */
  execCaptureBytes(ref: string, shellCmd: string): Promise<{ exitCode: number; stdout: Uint8Array }>;
  /** Interactive PTY attached to a command in the guest (the terminal bridge). */
  terminal(ref: string, cmd: string[], size: { cols: number; rows: number }): TerminalHandle;
}
