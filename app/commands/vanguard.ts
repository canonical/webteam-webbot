import { logger } from "../utils/logger";
import config from "../config";
import { ChatCommand, ChatCommandContext } from "../services/chatCommands";

export const vanguardCommand: ChatCommand = {
  command: "vanguard",
  description: "Set or update alerts channel vanguards.",
  usage: "vanguard @user1 | clear",
  aliases: ["van", "guard"],
  handler: async ({
    mattermostService,
    channelId,
    userId,
    args,
  }: ChatCommandContext): Promise<void> => {
    const ALERTS_CHANNEL_ID = config.notifications.alerts_channel_id;

    if (channelId !== ALERTS_CHANNEL_ID) {
      return;
    }

    if (args.length === 0) {
      await mattermostService.sendMessage(
        channelId,
        "❌ Specify at least one user to set as vanguard"
      );
      return;
    }

    if (args.length === 1 && args[0] && args[0].toLowerCase() === "clear") {
      const channel = await mattermostService.getChannelById(channelId);
      const currentHeader = channel.header || "";
      const newHeader = currentHeader
        .replace(/\s*\|\s*Vanguards:.*$/, "")
        .trim();
      await mattermostService.updateChannelHeader(channelId, newHeader);
      return;
    }

    const vanguardUsers = args.map((arg) => arg.replace(/^@/, ""));

    if (vanguardUsers.length === 0) {
      await mattermostService.sendMessage(
        channelId,
        "Specify at least one user (e.g., `vanguard @user1`)"
      );
      return;
    }

    try {
      const channel = await mattermostService.getChannelById(channelId);
      const currentHeader = channel.header || "";

      let newHeader = currentHeader.replace(/\s*\|\s*Vanguards:.*$/, "");

      const vanguardSection = ` | Vanguards: ${vanguardUsers
        .map((u) => `@${u}`)
        .join(" ")}`;
      newHeader = newHeader.trim() + vanguardSection;

      await mattermostService.updateChannelHeader(channelId, newHeader);

      logger.info(`Vanguards updated for channel ${channelId}`, {
        channelId,
        vanguards: vanguardUsers,
        updatedBy: userId,
      });
    } catch (error) {
      logger.error(
        `Failed to update vanguards for channel ${channelId}:`,
        error
      );
      await mattermostService.sendMessage(
        channelId,
        "❌ Failed to update channel vanguards. Please check permissions."
      );
    }
  },
};
