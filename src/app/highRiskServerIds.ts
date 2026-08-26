import type {
  ProxyProfile,
  ServerId,
  ServerProfile,
} from "../configuration";

export function collectHighRiskServerIds(
  servers: readonly ServerProfile[],
  proxies: readonly ProxyProfile[],
): ReadonlySet<ServerId> {
  const proxiesById = new Map(proxies.map((proxy) => [proxy.proxyId, proxy]));
  const serverIds = new Set<ServerId>();
  for (const server of servers) {
    const configuration = server.configuration;
    if (configuration.type !== "remoteWebSocket") {
      continue;
    }
    const proxy =
      configuration.proxyId === undefined
        ? undefined
        : proxiesById.get(configuration.proxyId);
    const proxyAllowsInvalidCertificate =
      proxy?.configuration.type === "httpConnect" &&
      proxy.configuration.tlsCertificatePolicy === "allowInvalidCertificate";
    if (
      configuration.tlsCertificatePolicy === "allowInvalidCertificate" ||
      proxyAllowsInvalidCertificate
    ) {
      serverIds.add(server.serverId);
    }
  }
  return serverIds;
}
