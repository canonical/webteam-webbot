import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";
import { LRUCache } from "../../utils/lruCache";
import { MessageAttachment } from "@mattermost/types/message_attachments";

const MAX_CACHE_SIZE = 100;
const ALERTMANAGER_BASE_URL =
  "http://cos.webdesign.canonical.com/prod-webdesign-cos-alertmanager";

const alertMessagesCache = new LRUCache<
  string,
  { postId: string; alerts: Set<string> }
>(MAX_CACHE_SIZE);

const site24x7MessagesCache = new LRUCache<string, { postId: string }>(
  MAX_CACHE_SIZE
);

export const router = Router();

router.post("/alertmanager", async (req, res) => {
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

async function createSite24x7Attachment(
  mattermostService: MattermostService,
  data: Site24x7WebhookData,
  alertsChannelId: string
): Promise<MessageAttachment> {
  const status = data.STATUS || "UNKNOWN";
  const monitorName = data.MONITORNAME || "Unknown Monitor";
  const monitorType = data.MONITORTYPE || "Unknown";
  const monitorUrl = data.MONITORURL || "";
  const incidentTime = data.INCIDENT_TIME || data.ALERT_TIME_IN_TEXT || "";
  const incidentReason = data.INCIDENT_REASON || "";
  const incidentDetails = data.INCIDENT_DETAILS || "";
  const dashboardLink = data.MONITOR_DASHBOARD_LINK || "";
  const tags = data.TAGS || "";
  const outageDuration = data.OUTAGE_DURATION || "";
  const alarmCategory = data.ALARM_CATEGORY || "";

  const title = `[${status}] ${monitorName}`;
  const color = getSite24x7Color(status);

  // Get vanguards for the channel
  const vanguards = await getChannelVanguard(
    mattermostService,
    alertsChannelId
  );

  const fields = [
    {
      short: true,
      title: "Monitor URL",
      value: monitorUrl || "N/A",
    },
    {
      short: true,
      title: "Incident Time",
      value: incidentTime || "N/A",
    },
  ];

  if (outageDuration && status.toUpperCase() !== "DOWN") {
    fields.push({
      short: true,
      title: "Outage Duration",
      value: outageDuration,
    });
  }

  if (tags) {
    fields.push({
      short: true,
      title: "Tags",
      value: tags,
    });
  }

  if (alarmCategory) {
    fields.push({
      short: true,
      title: "Alarm Category",
      value: alarmCategory,
    });
  }

  // Add actions and vanguards
  const actionFields = [];

  if (dashboardLink) {
    actionFields.push({
      short: true,
      title: "Actions",
      value: `[📊 View Dashboard](${dashboardLink})`,
    });
  }

  if (data.RCA_LINK) {
    actionFields.push({
      short: true,
      title: "Root Cause Analysis",
      value: `[🔍 View RCA](${data.RCA_LINK})`,
    });
  }

  actionFields.push({
    short: true,
    title: "Vanguard",
    value:
      vanguards.length > 0
        ? vanguards.map((v) => `@${v}`).join(" ")
        : "No vanguards assigned",
  });

  fields.push(...actionFields);

  let text = "";
  if (incidentReason) {
    text += `**Reason:** ${incidentReason}\n`;
  }
  if (incidentDetails) {
    text += `**Details:** ${incidentDetails}\n`;
  }

  return {
    color,
    title,
    text: text.trim(),
    fields,
    title_link: dashboardLink || undefined,
  };
}

function getSite24x7Color(status: string): string {
  switch (status.toUpperCase()) {
    case "DOWN":
    case "CRITICAL":
      return "danger";
    case "TROUBLE":
      return "warning";
    case "UP":
      return "good";
    default:
      return "#439FE0";
  }
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

type Site24x7WebhookData = {
  STATUS?: string;
  MONITORTYPE?: string;
  MONITORNAME?: string;
  MONITORURL?: string;
  INCIDENT_TIME?: string;
  INCIDENT_REASON?: string;
  INCIDENT_DETAILS?: string;
  FAILED_LOCATIONS?: string;
  MONITOR_DASHBOARD_LINK?: string;
  TAGS?: string;
  MONITOR_GROUPNAME?: string;
  OUTAGE_TIME_UNIX_FORMAT?: string;
  BU_NAME?: string;
  FAILED_CHILD_RESOURCE?: string;
  RCA_LINK?: string;
  OUTAGE_DURATION?: string;
  ALERT_TIME?: string;
  ALERT_TIME_IN_TEXT?: string;
  FAILED_ATTRIBUTES?: string;
  STATUS_CHANGE_ATTRIBUTES?: string;
  ALARM_CATEGORY?: string;
  ATTRIBUTE_NAMES?: string;
};

// Site 24x7 alerts
router.post("/site24x7", async (req, res) => {
  const DEFAULT_ALERTS_CHANNEL_ID = config.notifications.alerts_channel_id;

  const specifiedChannelId = req.query.channel_id as string;

  const ALERTS_CHANNEL_ID = specifiedChannelId || DEFAULT_ALERTS_CHANNEL_ID;

  if (!ALERTS_CHANNEL_ID) {
    logger.warn("ALERTS_CHANNEL_ID not set - skipping Site24x7 webhook");
    res.status(500).send("ALERTS_CHANNEL_ID not configured");
    return;
  }

  try {
    const site24x7Data = req.body;
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;

    logger.info("Received Site24x7 webhook", {
      status: site24x7Data.STATUS,
      monitorName: site24x7Data.MONITORNAME,
      monitorType: site24x7Data.MONITORTYPE,
    });

    const status = site24x7Data.STATUS || "UNKNOWN";
    const monitorName = site24x7Data.MONITORNAME || "Unknown Monitor";
    const cacheKey = `site24x7_${monitorName}`;

    const attachment = await createSite24x7Attachment(
      mattermostService,
      site24x7Data,
      ALERTS_CHANNEL_ID
    );

    if (status.toUpperCase() === "UP") {
      // Handle UP/resolve message - reply to original alert if it exists
      const cachedData = site24x7MessagesCache.get(cacheKey);

      if (cachedData) {
        await mattermostService.sendMessageWithAttachments(
          ALERTS_CHANNEL_ID,
          "",
          [attachment],
          cachedData.postId
        );

        site24x7MessagesCache.delete(cacheKey);
      } else {
        await mattermostService.sendMessageWithAttachments(
          ALERTS_CHANNEL_ID,
          "",
          [attachment]
        );
      }
    } else {
      // Handle DOWN/alert message - create new alert and cache it

      const postId = await mattermostService.sendMessageWithAttachments(
        ALERTS_CHANNEL_ID,
        "",
        [attachment]
      );
      if (postId) {
        site24x7MessagesCache.set(cacheKey, { postId });
      }
    }

    logger.info("Site24x7 alert processed successfully", {
      monitorName: site24x7Data.MONITORNAME,
      status: site24x7Data.STATUS,
    });

    res.send("OK");
  } catch (error) {
    logger.error("Site24x7 webhook error:", error);
    res.status(500).send("Internal server error");
  }
});
