import { logger } from "../utils/logger";
import { MattermostService, MessageEvent } from "./mattermost";
import { botCommands } from "../commands";
import { Post } from "@mattermost/types/posts";

export interface ChatCommandContext {
  mattermostService: MattermostService;
  channelId: string;
  userId: string;
  args: string[];
  rootId?: string;
  post: Post;
}

export interface ChatCommand {
  command: string;
  description: string;
  usage?: string;
  aliases?: string[];
  handler: (context: ChatCommandContext) => Promise<void>;
}

const COMMAND_PREFIX = "!";

export class ChatCommandService {
  private commands: Map<string, ChatCommand> = new Map();
  private mattermostService: MattermostService;

  constructor(mattermostService: MattermostService) {
    this.mattermostService = mattermostService;
    this.initializeCommands();
  }

  private initializeCommands(): void {
    botCommands.forEach((command) => {
      this.registerCommand(command);

      if (command.aliases) {
        command.aliases.forEach((alias) => {
          this.commands.set(alias.toLowerCase(), command);
          logger.debug(
            `Registered chat command alias: ${COMMAND_PREFIX}${alias} -> ${command.command}`
          );
        });
      }
    });
  }

  public registerCommand(command: ChatCommand): void {
    this.commands.set(command.command.toLowerCase(), command);
    logger.debug(
      `Registered chat command: ${COMMAND_PREFIX}${command.command}`
    );
  }

  public async handleMessage(event: MessageEvent, post: Post): Promise<void> {
    const message = post.message || "";

    if (!message.startsWith(COMMAND_PREFIX)) {
      return;
    }

    const parts = message.slice(1).trim().split(/\s+/);
    const commandName = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    if (!commandName) {
      return;
    }

    if (commandName === "help") {
      let message = "";
      message += `**Available Commands:**\n`;
      botCommands.forEach((cmd) => {
        message += `• \`${COMMAND_PREFIX}${cmd.command}\` - ${cmd.description}\n`;
        if (cmd.aliases && cmd.aliases.length > 0) {
          message += `  Aliases: ${cmd.aliases
            ?.map((a) => `\`${COMMAND_PREFIX}${a}\``)
            .join(", ")}\n`;
        }
        if (cmd.usage) {
          message += `  Usage: \`${COMMAND_PREFIX}${cmd.usage}\`\n`;
        }
      });
      await this.mattermostService.sendMessage(post.channel_id, message);
    }

    const command = this.commands.get(commandName);
    if (!command) {
      return;
    }

    try {
      const context: ChatCommandContext = {
        mattermostService: this.mattermostService,
        channelId: post.channel_id,
        userId: post.user_id,
        args,
        rootId: post.root_id,
        post,
      };

      await command.handler(context);
    } catch (error) {
      logger.error(
        `Error executing command ${COMMAND_PREFIX}${commandName}`,
        error
      );
      await this.mattermostService.sendMessage(
        post.channel_id,
        `Error executing command: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  public getAvailableCommands(): ChatCommand[] {
    return Array.from(this.commands.values());
  }
}
