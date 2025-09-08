import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";

export const router = Router();

// POST /figma-library-alert
router.post("/figma-library-alert", async (req, res) => {
  const room = "figma-library-maintainers";
  const mattermostService: MattermostService = req.app.locals.mattermostService;

  // Google Drive webhook
  if (req.headers["x-goog-channel-id"]) {
    const token = req.headers["x-goog-channel-token"];
    const resourceState = req.headers["x-goog-resource-state"];
    const changed = req.headers["x-goog-changed"];
    const message = `On Google Drive ${token} changed. Action type: ${resourceState} ${changed ? `Change type: ${changed}` : ""}`;

    try {
      if (resourceState !== "sync" && resourceState !== "add") {
        if (typeof changed === "string") {
          const changedArray = changed.split(",").map((item) => item.trim());
          const uninterestingChanges = ["parents", "permissions", "properties"];
          const hasInterestingChange = changedArray.some((change) => !uninterestingChanges.includes(change));
          if (hasInterestingChange) {
            await mattermostService.sendMessageToRoom(room, message);
          }
        } else {
          await mattermostService.sendMessageToRoom(room, message);
        }
      }
    } catch (error) {
      logger.error("Figma library alert error", error);
      await mattermostService.sendMessageToRoom(room, `Whoa, I got an error: ${error}`);
    }
  } else {
    // Github Actions or other source
    const data = req.body;
    if (data) {
      const message = `${data["source"]} has changed. Changes: ${data["change-summary"]}.`;
      try {
        await mattermostService.sendMessageToRoom(room, message);
      } catch (error) {
        logger.error("Figma library alert error", error);
        await mattermostService.sendMessageToRoom(room, `Whoa, I got an error: ${error}`);
      }
    }
  }
  res.status(200).end("");
});
