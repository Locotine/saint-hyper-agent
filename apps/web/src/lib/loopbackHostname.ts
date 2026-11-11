// FILE: loopbackHostname.ts
// Purpose: Loopback hostname check with no app-store imports, safe for transport code.
// Exports: isLoopbackHostname

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]"
  );
}
