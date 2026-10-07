import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";
import { MessageAttachment } from "@mattermost/types/message_attachments";

export const router = Router();

router.post("/sentry", async (req, res): Promise<void> => {
  const { sentry_channel_id, sentry_project_channels } = config.notifications;

  if (!sentry_channel_id) {
    logger.warn("sentry_channel_id not set - skipping sentry webhook");
    res.status(500).send("sentry_channel_id not configured");
    return;
  }

  if (req.get("Sentry-Hook-Resource") !== "issue") {
    res.status(400).send("Unexpected webhook resource");
    return;
  }

  try {
    const payload = req.body;
    const issue = payload?.data?.issue;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    if (
      payload.action !== "created" ||
      !issue ||
      issue.status !== "unresolved" ||
      issue.substatus !== "new" ||
      issue.issueCategory !== "error"
    ) {
      logger.debug("Ignoring sentry webhook payload", {
        action: payload.action,
        substatus: issue?.substatus,
        issueCategory: issue?.issueCategory,
      });
      res.send("OK");
      return;
    }

    const channelId =
      sentry_project_channels?.[issue.project?.slug || ""] ||
      sentry_channel_id;

    const attachment = createSentryAttachment(issue);
    await mattermostService.sendMessageWithAttachments(channelId, "", [
      attachment,
    ]);

    logger.info(`Posted new sentry issue ${issue.shortId}`, {
      issueId: issue.id,
      project: issue.project?.slug,
      channelId,
    });
    res.send("OK");
  } catch (error) {
    logger.error("Sentry webhook error:", error);
    res.status(500).send("Internal server error");
  }
});

function getPriorityColor(priority?: string): string {
  switch (priority) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    default:
      return "#439FE0";
  }
}

function createSentryAttachment(issue: SentryIssue): MessageAttachment {
  const fields = [
    { short: true, title: "Project", value: issue.project?.slug || "unknown" },
    { short: true, title: "Level", value: issue.level || "unknown" },
    {
      short: true,
      title: "Culprit",
      value: issue.culprit ? `\`${issue.culprit}\`` : "unknown",
    },
    {
      short: true,
      title: "Users affected",
      value: String(issue.userCount ?? 0),
    },
  ];

  return {
    color: getPriorityColor(issue.priority),
    title: `New issue: ${issue.shortId} — ${issue.title}`,
    title_link: issue.permalink,
    fields,
    text: `First seen: ${issue.firstSeen || "unknown"}`,
  };
}

type SentryIssue = {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string;
  permalink: string;
  level?: string;
  status: string;
  substatus?: string;
  issueCategory?: string;
  priority?: string;
  userCount?: number;
  firstSeen?: string;
  project?: {
    slug?: string;
    name?: string;
  };
};