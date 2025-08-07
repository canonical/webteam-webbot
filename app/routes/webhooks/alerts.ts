import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";
import { LRUCache } from "../../utils/lruCache";
import { MessageAttachment } from "@mattermost/types/message_attachments";
import { webhooksRouter } from ".";

const MAX_CACHE_SIZE = 100;
const ALERTMANAGER_BASE_URL =
  "http://cos.webdesign.canonical.com/prod-webdesign-cos-alertmanager";

const alertMessagesCache = new LRUCache<
  string,
  { postId: string; alerts: Set<string> }
>(MAX_CACHE_SIZE);

webhooksRouter.post("/alertmanager", async (req, res) => {
  const ALERTS_CHANNEL_ID = config.notifications.alerts_channel_id;

  if (!ALERTS_CHANNEL_ID) {
    logger.warn("ALERTS_CHANNEL_ID not set - skipping alertmanager webhook");
    res.status(500).send("ALERTS_CHANNEL_ID not configured");
    return;
  }

  try {
    const payload = req.body;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    if (!Array.isArray(payload.alerts)) {
      res.status(400).send("Invalid payload: alerts array required");
      return;
    }

    const groupKey =
      payload.groupKey || JSON.stringify(payload.commonLabels || {});
    const status = payload.status || "unknown";
    const alertName = payload.commonLabels?.alertname || "Unknown Alert";
    const severity = payload.commonLabels?.severity || "unknown";

    if (status === "resolved") {
      await handleResolvedAlerts(
        mattermostService,
        groupKey,
        payload,
        alertName,
        severity,
        ALERTS_CHANNEL_ID
      );
    } else {
      await processAlert(
        mattermostService,
        groupKey,
        payload,
        alertName,
        severity,
        ALERTS_CHANNEL_ID
      );
    }

    logger.info(`Processed ${payload.alerts.length} alerts from alertmanager`, {
      groupKey,
      status,
      receiver: payload.receiver,
      alertName,
      severity,
    });
    console.log(alertMessagesCache);

    res.send("OK");
  } catch (error) {
    logger.error("Alertmanager webhook error:", error);
    res.status(500).send("Internal server error");
  }
});

async function processAlert(
  mattermostService: MattermostService,
  groupKey: string,
  payload: AlertManagerPayload,
  alertName: string,
  severity: string,
  alertsChannelId: string
) {
  let groupData = alertMessagesCache.get(groupKey);

  if (!groupData) {
    const attachment = await createAlertAttachment(
      mattermostService,
      payload,
      payload.alerts.length,
      alertsChannelId
    );
    const postId = await mattermostService.sendMessageWithAttachments(
      alertsChannelId,
      "",
      [attachment]
    );
    groupData = { postId: postId!, alerts: new Set() };
    alertMessagesCache.set(groupKey, groupData);
    payload.alerts
      .filter((a) => a.status === "firing")
      .forEach(async (alert) => {
        if (!groupData!.alerts.has(alert.fingerprint)) {
          groupData!.alerts.add(alert.fingerprint);
        }
      });

    logger.debug(`Created new thread for group ${groupKey}`, {
      postId,
      alertName,
      severity,
    });
  }
}

async function handleResolvedAlerts(
  mattermostService: MattermostService,
  groupKey: string,
  payload: AlertManagerPayload,
  alertName: string,
  severity: string,
  alertsChannelId: string
) {
  const groupData = alertMessagesCache.get(groupKey);

  if (!groupData) {
    // No existing thread — post standalone resolved messages
    for (const alert of payload.alerts) {
      const msg =
        alert.annotations?.summary ||
        `${alert.labels?.instance || ""} resolved`;
      await mattermostService.sendMessage(
        alertsChannelId,
        `✅ RESOLVED (no thread found): ${msg}`
      );
    }
    return;
  }

  // Reply in thread for each resolved alert
  for (const alert of payload.alerts) {
    if (groupData.alerts.has(alert.fingerprint)) {
      const msg =
        alert.annotations?.summary ||
        `${alert.labels?.instance || ""} resolved`;
      await mattermostService.sendMessage(
        alertsChannelId,
        `✅ ${msg}`,
        groupData.postId
      );
      groupData.alerts.delete(alert.fingerprint);

      logger.debug(`Resolved alert ${alert.fingerprint} in group ${groupKey}`, {
        alertName,
        severity,
      });
    }
  }

  if (groupData.alerts.size === 0) {
    await mattermostService.sendMessage(
      alertsChannelId,
      `✅ **All alerts in group resolved**: ${alertName}`,
      groupData.postId
    );
    alertMessagesCache.delete(groupKey);

    logger.debug(`Group ${groupKey} fully resolved`, { alertName, severity });
  }
}

async function getChannelVanguard(
  mattermostService: MattermostService,
  channelId: string
): Promise<string[]> {
  const channel = await mattermostService.getChannelById(channelId);
  const header = channel.header || "";
  // the header ends with Vanguards: @mhdisk @james
  const vanguardMatch = header.match(/Vanguards:\s*(.*)/);
  if (vanguardMatch && vanguardMatch[1]) {
    return vanguardMatch[1]
      .split(/\s+/)
      .map((username: string) => username.replace(/^@/, ""));
  }
  return [];
}

async function createAlertAttachment(
  mattermostService: MattermostService,
  payload: AlertManagerPayload,
  firingCount: number,
  alertsChannelId: string
): Promise<MessageAttachment> {
  const commonLabels = payload.commonLabels || {};
  const alerts = payload.alerts || [];
  const status = payload.status || "unknown";
  const severity = commonLabels.severity || "unknown";
  const alertName = commonLabels.alertname || "Unknown Alert";

  const title = getMattermostTitle(status, alertName, firingCount);
  const color = getMattermostColor(status, severity);
  const silenceLink = getAlertSilenceLink(commonLabels);
  const alertManagerLink = `${ALERTMANAGER_BASE_URL}/#/alerts?receiver=${encodeURIComponent(
    payload.receiver || ""
  )}`;
  const vanguards = await getChannelVanguard(
    mattermostService,
    alertsChannelId
  );

  const fields = [
    {
      short: true,
      title: "Actions",
      value: `[:no_bell: Silence this alert](${silenceLink}) • [🔍 View in Alertmanager](${alertManagerLink})`,
    },
    {
      short: true,
      title: "Vanguard",
      value:
        vanguards.length > 0
          ? vanguards.map((v) => `@${v}`).join(" ")
          : "No vanguards assigned",
    },
  ];

  let text = "";
  for (const alert of alerts) {
    if (alert.annotations?.summary) {
      text += `• ${alert.annotations.summary}\n`;
    }
  }

  return {
    color,
    title,
    text: text.trim(),
    fields,
    title_link: `${ALERTMANAGER_BASE_URL}/#/alerts?receiver=${encodeURIComponent(
      payload.receiver || ""
    )}&filter=%7Balertname%3D%22${encodeURIComponent(alertName)}%22%7D`,
  };
}

function getAlertSilenceLink(commonLabels: Record<string, string>): string {
  const filters: string[] = [];
  Object.entries(commonLabels).forEach(([name, value]) => {
    if (name !== "alertname") {
      filters.push(`${name}%3D"${encodeURIComponent(value)}"%2C%20`);
    }
  });
  if (commonLabels.alertname) {
    filters.push(`alertname%3D"${encodeURIComponent(commonLabels.alertname)}"`);
  }
  return `${ALERTMANAGER_BASE_URL}/#/silences/new?filter=%7B${filters.join(
    ""
  )}%7D`;
}

function getMattermostTitle(
  status: string,
  alertname: string,
  firingCount?: number
): string {
  const statusUpper = status.toUpperCase();
  const countSuffix =
    status === "firing" && firingCount ? `:${firingCount}` : "";
  return `[${statusUpper}${countSuffix}] ${alertname}`;
}

function getMattermostColor(status: string, severity: string): string {
  if (status === "firing") {
    switch (severity) {
      case "warning":
        return "warning";
      case "critical":
        return "danger";
      default:
        return "#439FE0";
    }
  }
  return "good";
}

type AlertManagerPayload = {
  alerts: Alert[];
  commonLabels?: Record<string, string>;
  status?: string;
  receiver?: string;
  groupKey?: string;
};

type Alert = {
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  status?: string;
  fingerprint: string;
};
