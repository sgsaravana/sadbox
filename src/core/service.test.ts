import { describe, expect, test } from "bun:test";
import { serveCommand, unitText } from "./service";

describe("the systemd unit", () => {
  const unit = unitText(["/home/me/.local/bin/sadbox", "serve"], {
    PATH: "/usr/bin:/bin", SADBOX_PORT: "8080", SADBOX_PASSWORD: "hunter2-hunter2", HOME: "/home/me", SADBOX_DATA: "/srv/100%/sadbox",
  });

  test("runs this sadbox, and keeps the VMs when it stops", () => {
    expect(unit).toContain('ExecStart="/home/me/.local/bin/sadbox" "serve"');
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("carries sadbox's settings and PATH, never the password", () => {
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain('Environment="SADBOX_PORT=8080"');
    expect(unit).toContain('Environment="SADBOX_DATA=/srv/100%%/sadbox"'); // % is systemd's specifier
    expect(unit).not.toContain("hunter2");
    expect(unit).not.toContain("HOME=");
  });

  test("from a checkout, it is bun running the source", () => {
    expect(serveCommand().slice(-2)).toEqual([Bun.main, "serve"]);
  });
});
