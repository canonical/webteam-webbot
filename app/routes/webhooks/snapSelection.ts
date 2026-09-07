import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";

export const router = Router();

type SnapSelectionPayload =
  | {
      success: true;
      snaps: Array<{ name: string; snap_id: string }>;
    }
  | {
      success: false;
      error: string;
    };

router.post("/snap-selection", async (req, res): Promise<void> => {
  const CHANNEL_ID = config.notifications.snap_selection_channel_id;

  if (!CHANNEL_ID) {
    logger.warn(
      "snap_selection_channel_id not set - skipping snap selection notification"
    );
    res.status(500).send("snap_selection_channel_id not configured");
    return;
  }

  try {
    const payload = req.body as SnapSelectionPayload;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    let message: string;

    if (!payload.success) {
      if (!payload.error) {
        res.status(400).send("Missing field: error is required on failure");
        return;
      }
      message =
        `:x: **Featured snaps automated selection failed:**\n` +
        `\`\`\`\n${payload.error}\n\`\`\``;
    } else {
      if (!Array.isArray(payload.snaps) || payload.snaps.length === 0) {
        res
          .status(400)
          .send("Missing or empty field: snaps is required on success");
        return;
      }

      const snapList = payload.snaps
        .map(
          ({ name }) =>
            `- [${name}](https://snapcraft.io/${encodeURIComponent(name)})`
        )
        .join("\n");

      message =
        `:white_check_mark: **Featured snaps list updated** (${payload.snaps.length} snaps):\n` +
        snapList;
    }

    await mattermostService.sendMessage(CHANNEL_ID, message);
    res.send("OK");
  } catch (error) {
    logger.error("Snap selection webhook error", error);
    res.status(500).send("Internal server error");
  }
});
