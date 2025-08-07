import { Client4 } from "@mattermost/client";
import { WebSocket } from "ws";
import { logger } from "../utils/logger";
import { MattermostConfig } from "../config";
import { MessageAttachment } from "@mattermost/types/message_attachments";
import { Channel, ServerChannel } from "@mattermost/types/channels";
import { UserProfile } from "@mattermost/types/users";
import { Post, PostList } from "@mattermost/types/posts";

export interface MattermostMessage {
  channel_id: string;
  message: string;
  root_id?: string;
}

export interface MattermostReaction {
  post_id: string;
  emoji_name: string;
  user_id: string;
}

export interface MessageEvent {
  event: string;
  data: {
    post?: string;
    mentions?: string[];
    channel_id?: string;
    user_id?: string;
  };
}

export type MessageHandler = (event: MessageEvent, post: Post) => Promise<void>;

export class MattermostService {
  private client: Client4;
  private wsClient: WebSocket | null = null;
  private accessToken: string;
  private host: string;
  private myId: string | null = null;
  private messageHandlers: MessageHandler[] = [];

  constructor(config: MattermostConfig) {
    this.accessToken = config.access_token || "";
    this.host = config.host || "chat.canonical.com";
    this.client = new Client4();

    if (!this.accessToken) {
      logger.warn(
        "Mattermost access token not provided - Mattermost features will be disabled"
      );
    }
  }

  public async initialize(): Promise<void> {
    if (!this.accessToken) {
      logger.warn("Skipping Mattermost initialization - no access token");
      return;
    }

    try {
      this.client.setUrl(`https://${this.host}`);
      this.client.setToken(this.accessToken);

      const me = await this.client.getMe();
      this.myId = me.id;
      logger.info(`Connected to Mattermost as ${me.username} (${me.id})`);

      await this.initializeWebSocket();
    } catch (error) {
      logger.error("Failed to initialize Mattermost connection:", error);
      throw error;
    }
  }

  private async initializeWebSocket(): Promise<void> {
    if (!this.accessToken || !this.myId) {
      return;
    }

    try {
      const wsUrl = `wss://${this.host}/api/v4/websocket`;

      this.wsClient = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      this.wsClient.on("open", () => {
        logger.info("WebSocket connection established");

        // Send authentication message
        if (this.wsClient) {
          this.wsClient.send(
            JSON.stringify({
              seq: 1,
              action: "authentication_challenge",
              data: {
                token: this.accessToken,
              },
            })
          );
        }
      });

      this.wsClient.on("message", async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.event === "posted" && message.data && message.data.post) {
            const post = JSON.parse(message.data.post);

            if (post.user_id !== this.myId) {
              for (const handler of this.messageHandlers) {
                await handler(message, post);
              }
            }
          }
        } catch (error) {
          logger.error("Error processing WebSocket message:", error);
        }
      });

      this.wsClient.on("error", (error: Error) => {
        logger.error("WebSocket error:", error);
      });

      this.wsClient.on("close", (code: number, reason: Buffer) => {
        logger.warn(
          `WebSocket connection closed: ${code} ${reason.toString()}`
        );
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (!this.wsClient || this.wsClient.readyState === WebSocket.CLOSED) {
            logger.info("Attempting to reconnect WebSocket...");
            this.initializeWebSocket().catch((err) => {
              logger.error("Failed to reconnect WebSocket:", err);
            });
          }
        }, 5000);
      });
    } catch (error) {
      logger.error("Failed to initialize WebSocket:", error);
      throw error;
    }
  }

  public addMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public removeMessageHandler(handler: MessageHandler): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index > -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  public async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
      logger.info("WebSocket connection closed");
    }
  }

  public async sendMessage(
    channelId: string,
    message: string,
    rootId?: string
  ): Promise<string | undefined> {
    if (!this.accessToken) {
      logger.warn("Cannot send message - Mattermost not configured");
      return;
    }

    try {
      const post = {
        channel_id: channelId,
        message,
        ...(rootId && { root_id: rootId }),
      };

      const response = await this.client.createPost(post);
      logger.debug(`Message sent to channel ${channelId}`);
      return response.id;
    } catch (error) {
      logger.error(`Failed to send message to channel ${channelId}:`, error);
      throw error;
    }
  }

  public async sendMessageWithAttachments(
    channelId: string,
    message: string,
    attachments: MessageAttachment[],
    rootId?: string
  ): Promise<string | undefined> {
    if (!this.accessToken) {
      logger.warn("Cannot send message - Mattermost not configured");
      return;
    }

    try {
      const post = {
        channel_id: channelId,
        message,
        props: {
          attachments,
        },
        ...(rootId && { root_id: rootId }),
      };

      const response = await this.client.createPost(post);
      logger.debug(`Message with attachments sent to channel ${channelId}`);
      return response.id;
    } catch (error) {
      logger.error(
        `Failed to send message with attachments to channel ${channelId}:`,
        error
      );
      throw error;
    }
  }

  public async sendMessageToRoom(
    roomName: string,
    message: string
  ): Promise<void> {
    if (!this.accessToken) {
      logger.warn("Cannot send message - Mattermost not configured");
      return;
    }

    try {
      let channel: ServerChannel | undefined = undefined;

      try {
        const teams = await this.client.getMyTeams();
        for (const team of teams) {
          try {
            channel = await this.client.getChannelByName(team.id, roomName);
            if (channel) {
              break;
            }
          } catch (teamError) {
            logger.debug(
              `Channel '${roomName}' not found in team ${team.name}`
            );
          }
        }
      } catch (teamsError) {
        logger.debug("Could not access teams, trying fallback method");
      }

      if (!channel) {
        try {
          const me = await this.client.getMe();
          const channels = await this.client.getMyChannels(me.id);
          channel = channels.find(
            (c) => c.name === roomName || c.display_name === roomName
          );
        } catch (channelsError) {
          logger.error("Could not access user channels:", channelsError);
        }
      }

      if (!channel) {
        logger.error(`Channel '${roomName}' not found or not accessible`);
        return;
      }

      await this.sendMessage(channel.id, message);
    } catch (error) {
      logger.error(`Failed to send message to room ${roomName}:`, error);
      throw error;
    }
  }

  public async addReaction(postId: string, emojiName: string): Promise<void> {
    if (!this.accessToken) {
      logger.warn("Cannot add reaction - Mattermost not configured");
      return;
    }

    try {
      const me = await this.client.getMe();
      await this.client.addReaction(me.id, postId, emojiName);
      logger.debug(`Reaction ${emojiName} added to post ${postId}`);
    } catch (error) {
      logger.error(`Failed to add reaction to post ${postId}:`, error);
      throw error;
    }
  }

  public async getChannelByName(name: string): Promise<ServerChannel> {
    if (!this.accessToken) {
      throw new Error("Mattermost not configured");
    }

    try {
      let channel: ServerChannel | undefined = undefined;

      try {
        const teams = await this.client.getMyTeams();
        for (const team of teams) {
          try {
            channel = await this.client.getChannelByName(team.id, name);
            if (channel) {
              break;
            }
          } catch (teamError) {
            logger.debug(`Channel '${name}' not found in team ${team.name}`);
          }
        }
      } catch (teamsError) {
        logger.debug("Could not access teams, trying fallback method");
      }

      if (!channel) {
        const me = await this.client.getMe();
        const channels = await this.client.getMyChannels(me.id);
        channel = channels.find(
          (c) => c.name === name || c.display_name === name
        );
      }

      if (!channel) {
        logger.error(`Channel '${name}' not found or not accessible`);
        throw new Error(`Channel '${name}' not found`);
      }
      return channel;
    } catch (error) {
      logger.error(`Failed to get channel ${name}:`, error);
      throw error;
    }
  }

  public async getUser(userId: string): Promise<UserProfile> {
    if (!this.accessToken) {
      throw new Error("Mattermost not configured");
    }

    try {
      return await this.client.getUser(userId);
    } catch (error) {
      logger.error(`Failed to get user ${userId}:`, error);
      throw error;
    }
  }

  public async getPosts(channelId: string): Promise<PostList> {
    if (!this.accessToken) {
      throw new Error("Mattermost not configured");
    }

    try {
      return await this.client.getPosts(channelId);
    } catch (error) {
      logger.error(`Failed to get posts for channel ${channelId}:`, error);
      throw error;
    }
  }

  public async getChannelById(channelId: string): Promise<Channel> {
    if (!this.accessToken) {
      throw new Error("Mattermost not configured");
    }

    try {
      return await this.client.getChannel(channelId);
    } catch (error) {
      logger.error(`Failed to get channel ${channelId}:`, error);
      throw error;
    }
  }

  public async updateChannelHeader(
    channelId: string,
    header: string
  ): Promise<void> {
    if (!this.accessToken) {
      throw new Error("Mattermost not configured");
    }

    try {
      await this.client.patchChannel(channelId, { header });
      logger.debug(`Channel header updated for channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to update channel header for ${channelId}:`, error);
      throw error;
    }
  }
}
