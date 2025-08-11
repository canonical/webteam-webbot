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

export function getConfig(): BotConfig {

	if (process.env["APP_CONFIG_FILE"]) {
		try {
			const config = JSON.parse(process.env["APP_CONFIG_FILE"]) as BotConfig;
			return config;
		} catch (error) {
			console.error("Error parsing APP_CONFIG_FILE environment variable:", error);
			throw new Error("Invalid configuration in APP_CONFIG_FILE");
		}
	}

	const configFilePath = fs.existsSync("config.local.json") ? "config.local.json" : "config.json"
	const fullPath = path.resolve(configFilePath);
	const fileContent = fs.readFileSync(fullPath, "utf-8");
	const conf = JSON.parse(fileContent) as BotConfig;
	return conf;
}

const config = getConfig();

export default config;
