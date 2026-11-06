import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Guards for user-supplied provider URLs (SSRF defence). A URL is accepted only if it is https, has no
 * credentials/query/fragment, uses the default port, and every address its host resolves to is public.
 * Residual risk: DNS can change between this check and the request (rebinding); redirects are refused by
 * callers (`redirect: "error"`) and responses are size-capped.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type Lookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true });

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = Math.floor(ipv4ToInt(base) / size) * size;
    return n >= start && n < start + size;
  });
}

/** Expands an IPv6 address into 8 16-bit groups (handles `::` and an embedded IPv4 tail). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = ipv4ToInt(tail[1]);
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const [head, rest, extra] = s.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  if (fill < 0 || (rest === undefined && h.length !== 8)) return null;
  const groups = [...h, ...new Array(fill).fill("0"), ...r].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for globally routable unicast addresses. Anything unparsable is treated as unsafe. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !v4Blocked(ip);
  if (family !== 6) return false;
  const g = expandV6(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped / compatible (::ffff:a.b.c.d, ::a.b.c.d) and NAT64 (64:ff9b::/96): judge the embedded IPv4.
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return !v4Blocked(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return !v4Blocked(embedded);
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return (g[0] & 0xe000) === 0x2000; // only 2000::/3 is global unicast
}

const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Syntactic checks. Returns the normalised URL (no trailing slash) or throws UnsafeUrlError. */
/** `allowQuery` is for download links, which are normally signed (`?X-Signature=...`); base URLs never allow one. */
export function parsePublicHttpsUrl(raw: string, options: { allowQuery?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("That is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("The address must start with https://.");
  if (url.username || url.password) throw new UnsafeUrlError("The address must not contain a username or password.");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("Only the default HTTPS port is allowed.");
  if ((url.search && !options.allowQuery) || url.hash) throw new UnsafeUrlError("The address must not contain a query string or fragment.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.test(host)) throw new UnsafeUrlError("That host is not allowed.");
  if (isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError("That address is not public.");
  if (!isIP(host) && !host.includes(".")) throw new UnsafeUrlError("The host must be a full domain name.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** Resolves the host and requires every address to be public. */
export async function assertPublicHost(url: URL, lookup: Lookup = defaultLookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("That address is not public.");
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UnsafeUrlError("The host name could not be resolved.");
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new UnsafeUrlError("That host resolves to a non-public address.");
  }
}

/** Full check used when a provider is saved and again before every request. */
export async function assertSafeBaseUrl(raw: string, lookup?: Lookup): Promise<URL> {
  const url = parsePublicHttpsUrl(raw);
  await assertPublicHost(url, lookup);
  return url;
}

/** Reads a response body, aborting once it exceeds `maxBytes`. */
export async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new UnsafeUrlError("The response is too large.");
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UnsafeUrlError("The response is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
