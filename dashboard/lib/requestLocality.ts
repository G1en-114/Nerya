// Shared rule for deciding whether an inbound dashboard request is a
// *trusted local* request (a browser on the same machine, talking to the
// Next server directly).
//
// A request counts as local only when BOTH hold:
//   1. it carries NO `x-forwarded-for` header at all — cloudflared (and any
//      other proxy in front of the dashboard) always appends one, so its
//      presence proves the call travelled through a proxy chain;
//   2. the `host` header (the server address as the client saw it) is
//      loopback-ish: localhost, 127.0.0.0/8, or ::1.
//
// Everything else — public traffic through the tunnel, LAN access, a
// missing host — is treated as remote and must present its own
// credentials. In particular it must never receive the server-side
// `NERYA_API_TOKEN` for free, and client-supplied headers are never
// enough to claim local trust on their own.

export function isLoopbackHost(rawHost: string): boolean {
  const host = (rawHost || "").trim().toLowerCase();
  if (!host) return false;
  let name = host;
  if (name.startsWith("[")) {
    // "[::1]:3000" -> "::1"
    const end = name.indexOf("]");
    name = end === -1 ? name.slice(1) : name.slice(1, end);
  } else if (name.includes(":") && name !== "::1") {
    // "127.0.0.1:3000" -> "127.0.0.1"
    name = name.split(":")[0];
  }
  return name === "localhost" || name === "::1" || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(name);
}

/**
 * True when every hop recorded in ``x-forwarded-for`` is a loopback address.
 *
 * Next.js (dev and standalone) appends its own loopback address to this
 * header on every request, so its mere presence cannot prove a remote
 * caller. What does prove one is a non-loopback hop anywhere in the chain:
 * a tunnel, a LAN proxy, or any real client that is not this machine.
 * Entries are ordered client-first, and each proxy appends the address it
 * saw, so all of them must be loopback for the request to have stayed local.
 */
function isLoopbackForwardChain(rawForwardedFor: string | null): boolean {
  const value = (rawForwardedFor || "").trim();
  if (!value) return true;
  const hops = value.split(",").map((hop) => hop.trim());
  if (!hops.length) return true;
  return hops.every((hop) => isLoopbackHost(hop));
}

export function isLocalRequest(req: Request): boolean {
  // The bundled server proves socket locality before Next inserts forwarding
  // headers. The random key is server-only and incoming proofs are stripped.
  const key = process.env.NERYA_LOCAL_PEER_KEY;
  if (key) return req.headers.get("x-nerya-local-peer") === key && isLoopbackHost(req.headers.get("host") || "");
  if (!isLoopbackForwardChain(req.headers.get("x-forwarded-for"))) return false;
  return isLoopbackHost(req.headers.get("host") || "");
}
