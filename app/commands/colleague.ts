import { logger } from "../utils/logger";
import { ChatCommand, ChatCommandContext } from "../services/chatCommands";

let teamMembersCache: TeamMember[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export const colleagueCommand: ChatCommand = {
  command: "colleague",
  description: "Get a random webteam colleague",
  usage: "colleague",
  handler: async (context: ChatCommandContext): Promise<void> => {
    const { channelId, rootId, mattermostService } = context;

    try {
      const teamMembers = await getTeamMembers("canonical-web-engineers");

      if (teamMembers.length === 0) {
        await mattermostService.sendMessage(
          channelId,
          "No team members found.",
          rootId
        );
        return;
      }

      const randomIndex = Math.floor(Math.random() * teamMembers.length);
      const randomMember = teamMembers[randomIndex];

      if (!randomMember) {
        await mattermostService.sendMessage(
          channelId,
          "No team members found.",
          rootId
        );
        return;
      }

      const message = `**${randomMember.name}** (@${randomMember.username})`;
      await mattermostService.sendMessage(channelId, message, rootId);
    } catch (error) {
      logger.error("Colleague command error:", error);
      await mattermostService.sendMessage(
        channelId,
        "Sorry, I couldn't find a random colleague right now.",
        rootId
      );
    }
  },
};

interface TeamMember {
  name: string;
  username: string;
}

interface LaunchpadPerson {
  display_name: string;
  name: string;
}

interface LaunchpadResponse {
  entries?: LaunchpadPerson[];
}

async function getTeamMembers(teamName: string): Promise<TeamMember[]> {
  const now = Date.now();

  if (teamMembersCache && now - cacheTimestamp < CACHE_TTL) {
    return teamMembersCache;
  }

  try {
    const response = await fetch(
      `https://api.launchpad.net/devel/~${teamName}/members`
    );

    if (!response.ok) {
      throw new Error(`Launchpad API error: ${response.status}`);
    }

    const data = (await response.json()) as LaunchpadResponse;
    const members =
      data.entries?.map((entry: LaunchpadPerson) => ({
        name: entry.display_name,
        username: entry.name,
      })) || [];

    members.sort((a, b) => a.name.localeCompare(b.name));

    teamMembersCache = members;
    cacheTimestamp = now;

    return members;
  } catch (error) {
    logger.error("Error fetching team members from Launchpad:", error);

    if (teamMembersCache) {
      logger.info("Returning stale cached team members");
      return teamMembersCache;
    }

    throw error;
  }
}
