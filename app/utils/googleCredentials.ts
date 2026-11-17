// Service account key fields, as stored in the bot config. The key is shared
// with other apps; Google's client only uses client_email and private_key and
// takes the token endpoint from its own defaults, the rest is kept so the
// whole key file can be pasted into the config.
export interface ServiceAccountConfig {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  token_uri: string;
}

// Config files are JSON strings, so the key's newlines arrive escaped.
// Throws if the section is missing, so a misconfigured bot fails loudly the
// first time it needs Google instead of silently listing every owner as unknown.
export function buildCredentials(
  account: ServiceAccountConfig | undefined,
): ServiceAccountConfig {
  if (!account?.client_email || !account.private_key) {
    throw new Error("google_docs credentials are not configured");
  }
  return { ...account, private_key: account.private_key.replace(/\\n/g, "\n") };
}
