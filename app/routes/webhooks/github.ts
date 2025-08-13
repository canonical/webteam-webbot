import { logger } from "../../utils/logger";
import { MattermostService } from "../../services/mattermost";
import { Router } from "express";

export const router = Router();

router.post("/gh-action-fail", async (req, res): Promise<void> => {
  try {
    const { repo_name, action_id, workflow } = req.body;
    const { room, custom_message } = req.query;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    if (!room) {
      res.status(400).send("Room parameter required");
      return;
    }

    let message = `[webteam-action] 🛑 The action ['${workflow}' failed](https://github.com/${repo_name}/actions/runs/${action_id})`;

    if (custom_message) {
      message = `[webteam-action] 🛑 ${custom_message}`;
    }

    await mattermostService.sendMessageToRoom(room as string, message);
    res.send("OK");
  } catch (error) {
    logger.error("GitHub action notification error", error);
    res.status(500).send("Internal server error");
  }
});
