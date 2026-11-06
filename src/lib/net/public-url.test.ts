import { describe, expect, it } from "vitest";
import { UnsafeUrlError, assertSafeBaseUrl, isPublicAddress, parsePublicHttpsUrl, readLimited } from "./public-url";

describe("isPublicAddress", () => {
  it("accepts ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("rejects loopback, private, link-local, metadata, CGNAT, multicast and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("172.32.0.1")).toBe(true); // just outside 172.16/12
    expect(isPublicAddress("100.63.255.255")).toBe(true);
  });

  it("rejects non-public IPv6, including IPv4-mapped and NAT64 forms of private addresses", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("treats garbage as unsafe", () => {
    for (const ip of ["", "not-an-ip", "999.1.1.1", "1.2.3", "::g"]) expect(isPublicAddress(ip), ip).toBe(false);
  });
});

describe("parsePublicHttpsUrl", () => {
  it("accepts and normalises a plain https API base", () => {
    expect(parsePublicHttpsUrl("https://api.together.xyz/v1/").href).toBe("https://api.together.xyz/v1");
    expect(parsePublicHttpsUrl("  https://api.example.com  ").href).toBe("https://api.example.com/");
    expect(parsePublicHttpsUrl("https://api.example.com:443/v1").hostname).toBe("api.example.com");
  });

  it("rejects non-https, credentials, odd ports, query/fragment, and internal-looking hosts", () => {
    const bad = [
      "http://api.example.com/v1", "ftp://x.example.com", "https://user:pw@api.example.com/v1", "https://api.example.com:8443/v1",
      "https://api.example.com/v1?x=1", "https://api.example.com/v1#frag", "https://localhost/v1", "https://app.localhost/v1",
      "https://intranet/v1", "https://printer.local/v1", "https://svc.internal/v1", "https://127.0.0.1/v1", "https://[::1]/v1",
      "https://169.254.169.254/latest/meta-data", "https://10.1.2.3/v1", "https://[::ffff:10.0.0.1]/v1", "javascript:alert(1)", "not a url", ""
    ];
    for (const u of bad) expect(() => parsePublicHttpsUrl(u), u).toThrow(UnsafeUrlError);
  });
});

describe("assertSafeBaseUrl", () => {
  const resolves = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));

  it("passes when every resolved address is public", async () => {
    await expect(assertSafeBaseUrl("https://api.example.com/v1", resolves("8.8.8.8", "2606:4700:4700::1111"))).resolves.toBeInstanceOf(URL);
  });

  it("fails when any address is private (including mixed answers), or resolution fails", async () => {
    await expect(assertSafeBaseUrl("https://evil.example.com/v1", resolves("10.0.0.5"))).rejects.toThrow(/non-public/);
    await expect(assertSafeBaseUrl("https://evil.example.com/v1", resolves("8.8.8.8", "169.254.169.254"))).rejects.toThrow(/non-public/);
    await expect(assertSafeBaseUrl("https://gone.example.com/v1", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(/could not be resolved/);
    await expect(assertSafeBaseUrl("https://empty.example.com/v1", resolves())).rejects.toThrow(/non-public/);
  });

  it("does not need DNS for a public IP literal", async () => {
    await expect(assertSafeBaseUrl("https://8.8.8.8/v1", async () => { throw new Error("should not resolve"); })).resolves.toBeInstanceOf(URL);
  });
});

describe("readLimited", () => {
  it("returns the body within the limit and rejects larger ones (declared or streamed)", async () => {
    expect((await readLimited(new Response(new Uint8Array(10)), 100)).length).toBe(10);
    await expect(readLimited(new Response(new Uint8Array(200)), 100)).rejects.toThrow(/too large/);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(80)); c.enqueue(new Uint8Array(80)); c.close(); } });
    await expect(readLimited(new Response(stream), 100)).rejects.toThrow(/too large/);
  });
});
