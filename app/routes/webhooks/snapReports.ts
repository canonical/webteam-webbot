import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";

export const router = Router();

router.post("/snap-report", async (req, res): Promise<void> => {
  const SNAP_REPORTS_CHANNEL_ID = config.notifications.snap_reports_channel_id;

  if (!SNAP_REPORTS_CHANNEL_ID) {
    logger.warn("SNAP_REPORTS_CHANNEL_ID not set - skipping snap report");
    res.status(500).send("SNAP_REPORTS_CHANNEL_ID not configured");
    return;
  }

  try {
    const { snap_name, reason, comment } = req.body;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    if (!snap_name || !reason || !comment) {
      res
        .status(400)
        .send("Missing fields: snap_name, reason, and comment are required");
      return;
    }

    const snapLink = `https://snapcraft.io/${encodeURIComponent(snap_name)}`;
    const message =
      `:warning: **Snap [${snap_name}](${snapLink}) has been reported:**\n` +
      `**Reason:** ${reason}\n` +
      `**Comment:** ${comment}`;

    await mattermostService.sendMessage(SNAP_REPORTS_CHANNEL_ID, message);
    res.send("OK");
  } catch (error) {
    logger.error("Snap report webhook error", error);
    res.status(500).send("Internal server error");
  }
});
