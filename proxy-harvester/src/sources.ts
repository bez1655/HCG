/**
 * Where candidate proxies come from.
 *
 * Every entry here was fetched and counted on 2026-08-05 before being added.
 * Two popular lists that show up in every "best proxy sources" article are
 * deliberately absent: proxy-list.download answers 502 and
 * mmpx12/proxy-list returns 404. Shipping a source that never parses would
 * look identical to a broken harvester.
 *
 * Sources are intentionally redundant. Any single list can go stale, rate
 * limit, or disappear; the harvester treats a dead source as a warning, not
 * an error, as long as others still deliver.
 */

export type Protocol = "socks5" | "http";

export interface Source {
  name: string;
  url: string;
  protocol: Protocol;
  /** Extract "host:port" pairs from the response body. */
  parse: (body: string) => string[];
}

/** Matches a bare IPv4:port anywhere in a line. */
const IPV4_PORT = /\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\b/g;

/**
 * Default parser: pull every IPv4:port out of the text.
 *
 * Deliberately tolerant. These lists carry banners, donation pleas and
 * country/anonymity suffixes (spys.me does all three), and a strict
 * line-based parser silently yields zero on the next format tweak.
 */
export function parsePlainText(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(IPV4_PORT)) {
    const host = match[1];
    const port = Number(match[2]);
    if (port < 1 || port > 65535) continue;
    if (!isSaneHost(host)) continue;
    found.push(`${host}:${port}`);
  }
  return found;
}

/** Geonode answers JSON, not text. */
export function parseGeonode(body: string): string[] {
  try {
    const data = JSON.parse(body) as { data?: Array<{ ip?: string; port?: string }> };
    if (!Array.isArray(data.data)) return [];
    return data.data
      .filter((row) => row.ip && row.port)
      .map((row) => `${row.ip}:${row.port}`)
      .filter((pair) => parsePlainText(pair).length === 1);
  } catch {
    return [];
  }
}

/**
 * Reject addresses that cannot be a useful public proxy.
 *
 * Private and loopback ranges appear in these lists regularly. Left in, they
 * would be probed from inside the container, where 127.0.0.1 and 10.x resolve
 * to the container itself or to the Docker network — a proxy that "works" in
 * the probe and fails for real traffic, or worse, a request aimed at our own
 * services.
 */
export function isSaneHost(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 127 || a >= 224) return false; // this-network, loopback, multicast/reserved
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false; // link-local
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  return true;
}

export const SOURCES: Source[] = [
  {
    name: "proxyscrape-socks5",
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "speedx-socks5",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "monosans-socks5",
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "hookzof-socks5",
    url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "jetkai-socks5",
    url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "roosterkid-socks5",
    url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "openproxylist-socks5",
    url: "https://api.openproxylist.xyz/socks5.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "proxyspace-socks5",
    url: "https://proxyspace.pro/socks5.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "spys-socks5",
    url: "https://spys.me/socks.txt",
    protocol: "socks5",
    parse: parsePlainText,
  },
  {
    name: "geonode-socks5",
    url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5",
    protocol: "socks5",
    parse: parseGeonode,
  },
  // HTTP proxies are a fallback. SOCKS5 is preferred for the Bot API, but
  // where every SOCKS5 address is dead an HTTP CONNECT proxy still works.
  {
    name: "proxyscrape-http",
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text",
    protocol: "http",
    parse: parsePlainText,
  },
  {
    name: "speedx-http",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    protocol: "http",
    parse: parsePlainText,
  },
];
