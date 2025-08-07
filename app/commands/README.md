# Chat Commands

This directory contains all chat commands for the bot. Chat commands are triggered by messages starting with `!` in Mattermost channels where the bot is mentioned.

## Adding a New Command


```typescript
import { ChatCommand, ChatCommandContext } from "../services/chatCommands";
import { logger } from "../utils/logger";

export const myCommand: ChatCommand = {
  command: "mycommand",
  description: "Description of what your command does",
  usage: "mycommand [args]", // Optional usage string
  aliases: ["mc", "mycmd"], // Optional aliases
  handler: async (context: ChatCommandContext): Promise<void> => {
    const { mattermostService, channelId, userId, args, post, rootId } = context;
    
    // Your command logic here
    try {
      // Example: Send a response
      // See the mattermost service for more actions!
      await mattermostService.sendMessage(
        channelId,
        "Hello from my new command!"
      );

      
      // Example: Log the command usage
      logger.info(`Command executed`, {
        command: "mycommand",
        channelId,
        userId,
        args,
      });
    } catch (error) {
      logger.error("Error in mycommand", error);
      await mattermostService.sendMessage(
        channelId,
        "Error executing command"
      );
    }
  }
};
```

2. **Export the command in `index.ts`**:

```typescript
import { myCommand } from "./mycommand";

export const allCommands: ChatCommand[] = [
  vanguardCommand,
  helpCommand,
  myCommand, // Add your new command here
];

```

3. **That's it!** Your command will be automatically registered when the bot starts.

## Command Interface

Each command must implement the `ChatCommand` interface:

```typescript
interface ChatCommandContext {
  mattermostService: MattermostService;
  channelId: string;
  userId: string;
  args: string[];
  rootId?: string;
  post: Post; // the full mattermost post object
}

interface ChatCommand {
  command: string;           // Command name (without the ! prefix)
  description: string;       // Help text shown in !help
  usage?: string;           // Optional usage string (shown in !help)
  aliases?: string[];       // Optional command aliases
  handler: (context: ChatCommandContext) => Promise<void>;
}
```