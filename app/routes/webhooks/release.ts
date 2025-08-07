import { logger } from "../../utils/logger";
import { MattermostService } from "../../services/mattermost";
import config from "../../config";
import { webhooksRouter } from ".";

webhooksRouter.post(
  "/release-notification",
  async (req, res): Promise<void> => {
    try {
      const { service_name, secret } = req.body;
      const mattermostService: MattermostService =
        req.app.locals.mattermostService;

      if (
        config.notifications.release_secret &&
        secret !== config.notifications.release_secret
      ) {
        res.status(401).send("Invalid secret");
        return;
      }

      if (!service_name) {
        res.status(400).send("Missing service_name");
        return;
      }

      const message = `[webteam-deploy] The webteam is deploying ${service_name} to production. Contact us in ~web--design`;
      const rooms = (config.notifications.release_rooms || "").split(",");

      for (const room of rooms) {
        if (room.trim()) {
          await mattermostService.sendMessageToRoom(room.trim(), message);
        }
      }

      res.send("OK");
    } catch (error) {
      logger.error("Release notification error", error);
      res.status(500).send("Internal server error");
    }
  }
);
