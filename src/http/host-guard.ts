import { isIP } from "node:net";
import type { RequestHandler } from "express";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function localHostsOnly(configuredHost: string): RequestHandler {
  const allowed = new Set(
    WILDCARD_HOSTS.has(configuredHost)
      ? LOOPBACK_HOSTS
      : [...LOOPBACK_HOSTS, asHostHeaderName(configuredHost)],
  );
  return (request, response, next) => {
    if (allowed.has(request.hostname.toLowerCase())) {
      next();
      return;
    }
    response
      .status(403)
      .json({ code: "host_not_allowed", message: "Requests must address this server directly." });
  };
}

function asHostHeaderName(host: string): string {
  const name = host.toLowerCase();
  return isIP(name) === 6 ? `[${name}]` : name;
}
