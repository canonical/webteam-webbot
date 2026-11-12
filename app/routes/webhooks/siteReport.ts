import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";

export const router = Router();

router.post("/site-report", async (req, res): Promise<void> => {
  const { site_report_channel_id, site_report_secret } = config.notifications;

  if (!site_report_channel_id || !site_report_secret) {
    logger.warn("site_report_channel_id or site_report_secret not set - skipping site report");
    res.status(500).send("Site report not configured");
    return;
  }

  try {
    const { secret, text } = req.body;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    if (secret !== site_report_secret) {
      res.status(401).send("Invalid secret");
      return;
    }

    if (!text) {
      res.status(400).send("Missing field: text");
      return;
    }

    await mattermostService.sendMessage(site_report_channel_id, text);
    res.send("OK");
  } catch (error) {
    logger.error("Site report webhook error", error);
    res.status(500).send("Internal server error");
  }
});
