import fs from "fs";
import path from "path";

export interface MattermostConfig {
  host: string;
  group: string;
  user: string;
  access_token: string;
  base_url: string;
  token: string;
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
  };

  github: {
    token: string;
  };

  google_sheets: {
    spreadsheet_id: string;
    client_email: string;
    private_key: string;
  };
}

export function getConfig(configPath = "config.json"): BotConfig {
  const fullPath = path.resolve(configPath);
  const fileContent = fs.readFileSync(fullPath, "utf-8");
  const conf = JSON.parse(fileContent) as BotConfig;
  return conf;
}

const config = getConfig(
  fs.existsSync("config.local.json") ? "config.local.json" : "config.json"
);

export default config;
