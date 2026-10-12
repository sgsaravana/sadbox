import { describe, expect, test } from "bun:test";
import { classifyAddress } from "./proxy";

// the machine's own interface addresses, as os.networkInterfaces() would list them
const own = new Set(["127.0.0.1", "::1", "192.168.50.48", "192.168.64.1", "fe80::1", "2001:db8::10"]);
const reach = (a: string) => classifyAddress(a, own);

describe("where a VM's request is allowed to go", () => {
  test("this machine is never a destination, by any of its addresses", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "0.0.0.0", "::1", "::", "[::1]",
                     "192.168.50.48", "192.168.64.1", "2001:db8::10", "2001:DB8::10", "fe80::1%en0"]) {
      expect(reach(a)).toBe("self");
    }
  });

  test("an IPv4-mapped IPv6 address is judged as the IPv4 address it is", () => {
    expect(reach("::ffff:127.0.0.1")).toBe("self");
    expect(reach("::ffff:192.168.50.48")).toBe("self");
    expect(reach("::ffff:10.0.0.5")).toBe("private");
    expect(reach("::ffff:93.184.216.34")).toBe("public");
  });

  test("LAN, link-local and carrier-NAT ranges are private", () => {
    for (const a of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.50.1",
                     "169.254.169.254", "100.64.0.1", "100.127.255.255", "fd00::1", "fc00::1", "fe80::abcd", "febf::1"]) {
      expect(reach(a)).toBe("private");
    }
  });

  test("everything else is public — including addresses just outside the private ranges", () => {
    for (const a of ["93.184.216.34", "1.1.1.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.1.1",
                     "169.253.1.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "2606:4700:4700::1111"]) {
      expect(reach(a)).toBe("public");
    }
  });
});
