import { logger } from "../../utils/logger";
import { MattermostService } from "../../services/mattermost";
import { Router } from "express";

export const router = Router();

router.post("/gh-security-events", async (req, res): Promise<void> => {
  try {
    const { room } = req.query;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    if (!room) {
      res.status(400).send("Room parameter required");
      return;
    }

    let message = "";
    if (req.body.repository_advisory) {
      const { repository_advisory, repository } = req.body;
      const severity = repository_advisory.severity || "unknown";
      const SEVERITY_LEVELS: { [key: string]: string } = {
        critical: "🔴 Critical",
        high: "🟠 High",
        medium: "🟡 Medium",
        low: "🟢 Low",
        unknown: "⚪ Unknown",
      };
      message = `[webteam-security] 🛡️ A new [security advisory](${
        repository_advisory.html_url
      }) has been published for the repository [${repository.full_name}](${
        repository.html_url
      }): *${repository_advisory.summary}* (Severity: ${
        SEVERITY_LEVELS[severity.toLowerCase()]
      })`;
    } else if (
      req.body.alert &&
      req.body.alert.rule &&
      req.body.alert.tool &&
      req.body.action === "created"
    ) {
      // Code Scanning Alert
      const { alert, repository } = req.body;
      const severity = alert.rule.severity || "unknown";
      message = `🔎 Code scanning alert in [${repository.full_name}](${repository.html_url}): *${alert.rule.description}* (Severity: ${severity}) [View alert](${alert.html_url})`;
    } else if (
      req.body.alert &&
      req.body.alert.security_advisory &&
      req.body.action === "created"
    ) {
      // Dependabot Alert
      const { alert, repository } = req.body;
      const severity = alert.security_advisory.severity || "unknown";
      message = `🤖 Dependabot alert in [${repository.full_name}](${repository.html_url}): *${alert.security_advisory.summary}* (Severity: ${severity}) [View alert](${alert.html_url})`;
    } else if (
      req.body.alert &&
      req.body.alert.secret_type &&
      req.body.action === "created"
    ) {
      // Secret Scanning Alert
      const { alert, repository } = req.body;
      message = `🔑 Secret scanning alert in [${repository.full_name}](${repository.html_url}): *${alert.secret_type_display_name}* detected. [View alert](${alert.html_url})`;
    } else {
      logger.info(
        "Ignored non-created or unrecognized GitHub security event",
        req.body.action
      );
      res.status(204).send(`Ignored event: ${req.body.action}`);
      return;
    }

    await mattermostService.sendMessageToRoom(room as string, message);
    res.send("OK");
  } catch (error) {
    logger.error("GitHub security events webhook error", error);
    res.status(500).send("Internal server error");
  }
});

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
