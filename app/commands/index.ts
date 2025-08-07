import { ChatCommand } from "../services/chatCommands";
import { vanguardCommand } from "./vanguard";
import { colleagueCommand } from "./colleague";

export const botCommands: ChatCommand[] = [vanguardCommand, colleagueCommand];
