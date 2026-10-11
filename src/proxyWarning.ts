/**
 * Notes on stderr (stdout carries the MCP protocol) when proxy variables are
 * set, because URL conversions connect directly and ignore them.
 */
export function warnIfProxyConfigured() {
  // Windows env lookups are case-insensitive, so one HTTPS_PROXY would
  // otherwise also show up as https_proxy; list each variable once.
  const seen = new Set<string>();
  const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    .filter((name) => {
      if (!process.env[name] || seen.has(name.toUpperCase())) return false;
      seen.add(name.toUpperCase());
      return true;
    });
  if (proxyVars.length > 0) {
    // stderr only: stdout carries the MCP protocol.
    console.error(
      `markdownify-mcp: ${proxyVars.join(", ")} ${proxyVars.length === 1 ? "is" : "are"} set, ` +
        "but URL conversions connect directly to the validated address and do not use a proxy.",
    );
  }
}
