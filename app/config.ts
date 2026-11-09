import fs from "fs";
import path from "path";

export interface MattermostConfig {
  host: string;
  group: string;
  user: string;
  access_token: string;
  base_url: string;
  token: string;
  // Listening for chat commands is on unless this is exactly false. Turn it off
  // for a local run with the production token, or both copies would answer.
  websocket_enabled?: boolean;
  commands: {
    acronym_token: string;
    meet_token: string;
    dir_token: string;
    explain_token: string;
  };
}

export interface BotConfig {
  server: {
    port: number;
    node_env: string;
  };

  mattermost: MattermostConfig;

  notifications: {
    release_rooms: string;
    release_secret: string;
    alerts_channel_id: string;
    snap_reports_channel_id: string;
    snap_selection_channel_id: string;
    sentry_channel_id: string;
    sentry_project_channels: Record<string, string>;
  };

  github: {
    token: string;
  };

  google_sheets: {
    spreadsheet_id: string;
    client_email: string;
    private_key: string;
  };

  // Optional: production config files predate these sections.
  // Dead link notifications. The endpoint refuses all requests without a token.
  dead_links?: {
    // Shared secret that the site's CI sends as a bearer token.
    token: string;
    // Direct messages are only sent when this is exactly true. Left off, the
    // bot still lists copydocs without a findable owner in the room.
    send_direct_messages?: boolean;
  };

  // A service account key that can read the copydocs (same fields as the key
  // file Google gives out).
  google_docs?: {
    type: string;
    project_id: string;
    private_key: string;
    client_email: string;
    client_id: string;
    token_uri: string;
  };
}

export function getConfig(): BotConfig {
  if (process.env["APP_CONFIG_FILE"]) {
    try {
      const config = JSON.parse(process.env["APP_CONFIG_FILE"]) as BotConfig;
      return config;
    } catch (error) {
      console.error(
        "Error parsing APP_CONFIG_FILE environment variable:",
        error,
      );
      throw new Error("Invalid configuration in APP_CONFIG_FILE");
    }
  }

  const configFilePath = fs.existsSync("config.local.json")
    ? "config.local.json"
    : "config.json";
  const fullPath = path.resolve(configFilePath);
  const fileContent = fs.readFileSync(fullPath, "utf-8");
  const conf = JSON.parse(fileContent) as BotConfig;
  return conf;
}

const config = getConfig();

export default config;
