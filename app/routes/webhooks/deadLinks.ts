import { createHash, timingSafeEqual } from "crypto";
import { Router } from "express";
import { logger } from "../../utils/logger";
import config from "../../config";
import { MattermostService } from "../../services/mattermost";
import { DocAccessError, getPageOwner } from "../../services/googleDocs";
import {
  DeadLinksDeps,
  DeadLinksPayload,
  processDeadLinks,
} from "../../services/deadLinks";

export const router = Router();

// The app's JSON body limit is 100 kB, so these only guard against absurd
// requests; the sender stays well under the limit by itself.
const MAX_PAGES = 500;
const MAX_LINKS_PER_PAGE = 500;
const MAX_WIDESPREAD_LINKS = 100;

// Hashing first makes both inputs the same length, which timingSafeEqual
// requires, and keeps the comparison time independent of the token's content.
function tokensMatch(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Absent or null is fine; anything else must be a string.
function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

// Returns an error message, or null when the payload is valid. Everything
// here ends up in messages sent to people, so the shape is checked strictly: a
// wrongly typed field would otherwise break building the message later.
export function validatePayload(body: any): string | null {
  if (!isString(body?.room)) {
    return "room is required";
  }
  if (!isOptionalString(body.run_url)) {
    return "run_url must be a string";
  }
  if (body.dry_run != null && typeof body.dry_run !== "boolean") {
    return "dry_run must be a boolean";
  }
  for (const field of ["omitted_pages", "omitted_links"]) {
    const value = body[field];
    if (value != null && !(Number.isInteger(value) && value >= 0)) {
      return `${field} must be a non-negative integer`;
    }
  }
  if (body.widespread_links != null) {
    if (
      !Array.isArray(body.widespread_links) ||
      body.widespread_links.length > MAX_WIDESPREAD_LINKS
    ) {
      return `widespread_links must be an array of at most ${MAX_WIDESPREAD_LINKS} items`;
    }
    for (const link of body.widespread_links) {
      if (
        !isString(link?.url) ||
        !isOptionalString(link.result) ||
        !(Number.isInteger(link.page_count) && link.page_count >= 0)
      ) {
        return "every widespread link needs a url, a page_count and, if any, a string result";
      }
    }
  }
  if (!Array.isArray(body.pages) || body.pages.length > MAX_PAGES) {
    return `pages must be an array of at most ${MAX_PAGES} items`;
  }
  for (const page of body.pages) {
    if (!isString(page?.page_url)) {
      return "every page needs a page_url";
    }
    if (page.copydoc_url != null && typeof page.copydoc_url !== "string") {
      return "copydoc_url must be a string or null";
    }
    if (page.fetch_failed != null && typeof page.fetch_failed !== "boolean") {
      return "fetch_failed must be a boolean";
    }
    if (
      !Array.isArray(page.broken_links) ||
      page.broken_links.length > MAX_LINKS_PER_PAGE ||
      !page.broken_links.every(
        (link: any) => isString(link?.url) && isOptionalString(link.result),
      )
    ) {
      return "every page needs a broken_links array of objects with a url and, if any, a string result";
    }
  }
  return null;
}

// Wires the processing logic to the real Google Docs and Mattermost clients.
function buildDeps(mattermost: MattermostService): DeadLinksDeps {
  return {
    getPageOwner,
    isDocAccessError: (error) => error instanceof DocAccessError,
    findUserByEmail: (email) => mattermost.getUserByEmail(email),
    searchUsers: (term) => mattermost.searchUsers(term),
    sendDirectMessage: (userId, message) =>
      mattermost.sendDirectMessage(userId, message),
    sendToRoom: async (room, message) => {
      const channel = await mattermost.getChannelByName(room);
      await mattermost.sendMessage(channel.id, message);
    },
  };
}

// Called by the ubuntu.com link checker workflow. Unlike the other webhooks it
// can send direct messages to people, so it requires a bearer token.
router.post("/dead-links", async (req, res): Promise<void> => {
  const expectedToken = config.dead_links?.token;
  // Without a configured token nobody could authenticate, so refuse everything
  // instead of leaving the endpoint open.
  if (!expectedToken) {
    logger.warn("dead_links.token not set - rejecting dead-links webhook");
    res.status(503).send("dead_links.token not configured");
    return;
  }

  const authorization = req.get("Authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!tokensMatch(provided, expectedToken)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const invalid = validatePayload(req.body);
  if (invalid) {
    res.status(400).send(invalid);
    return;
  }

  try {
    const mattermostService: MattermostService =
      req.app.locals.mattermostService;
    const result = await processDeadLinks(
      req.body as DeadLinksPayload,
      buildDeps(mattermostService),
      // Only an explicit true turns direct messages on; a missing or false
      // setting is a dry run.
      { sendDirectMessages: config.dead_links?.send_direct_messages === true },
    );
    logger.info("Dead links processed", {
      dry_run: result.dry_run,
      sent: result.sent.length,
      resolved_owners: result.resolved_owners,
      unresolved: result.unresolved.length,
      widespread_links: result.widespread_links,
    });
    // The channel had something to report and the post failed, so part of the
    // report reached nobody. Say so instead of answering 200, so that the
    // caller's step shows a failure.
    if (result.delivery_failed) {
      logger.error("Dead links report could not be delivered to the room");
      res.status(502).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    logger.error("Dead links webhook error", error);
    res.status(500).send("Internal server error");
  }
});
