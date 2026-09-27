// Fake connection-params for the desktop-adapter integration tests.
// Mirrors the real module's export surface; parsing is minimal but follows the
// same sid/hash/t requirements so the adapter's secret scrubbing stays honest.
export interface RemoteConnectionParams {
  deviceSid: string;
  passHash: string;
  source: URL;
  timestamp: number;
}

export function parseRemoteConnectionUrl(raw: string): RemoteConnectionParams | undefined {
  let source: URL;
  try {
    source = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const deviceSid = source.searchParams.get("sid") ?? undefined;
  const passHash = source.searchParams.get("hash") ?? undefined;
  const timestampRaw = source.searchParams.get("t") ?? undefined;
  const timestamp = timestampRaw !== undefined && /^\d+$/u.test(timestampRaw) ? Number(timestampRaw) : undefined;
  if (deviceSid === undefined || passHash === undefined || timestamp === undefined) return undefined;
  return { deviceSid, passHash, source, timestamp };
}

export function redactRemoteConnectionUrl(): string {
  return "<redacted>";
}
