// Turns a link checker report into notifications.
//
// For each page's copydoc we find the page owner, match them to a Mattermost
// user and send them one direct message covering all their pages. Copydocs
// whose owner cannot be found or matched are listed in a channel instead, so no
// broken link is silently dropped.
import { extractDocId, normalizeName, PageOwner } from "../utils/copydoc";
import { logger } from "../utils/logger";

export interface BrokenLink {
  url: string;
  result?: string;
}

export interface PageReport {
  page_url: string;
  // The page's <meta name="copydoc"> value; null if the page has none.
  copydoc_url: string | null;
  broken_links: BrokenLink[];
}

export interface DeadLinksPayload {
  // Channel for the list of copydocs whose owner could not be notified.
  room: string;
  run_url?: string;
  // Sent by the site's CI while its LINK_CHECKER_NOTIFY_PAGE_OWNERS variable is
  // not "true":
  // no direct messages for this request, even if the bot config allows them.
  dry_run?: boolean;
  // Left out by the sender to keep the request small.
  omitted_pages?: number;
  omitted_links?: number;
  pages: PageReport[];
}

export interface MmUser {
  id: string;
  username: string;
  // At Canonical the full name is stored in first_name and last_name is empty,
  // so names are compared on both fields joined together.
  first_name: string;
  last_name: string;
  is_bot?: boolean;
  delete_at?: number;
}

// Implemented by the route; kept as an interface so the logic is testable.
export interface DeadLinksDeps {
  getPageOwner(docId: string): Promise<PageOwner | null>;
  isDocAccessError(error: unknown): boolean;
  findUserByEmail(email: string): Promise<MmUser | null>;
  searchUsers(term: string): Promise<MmUser[]>;
  sendDirectMessage(userId: string, message: string): Promise<void>;
  sendToRoom(room: string, message: string): Promise<void>;
}

export interface UnresolvedCopydoc {
  copydoc_url: string | null;
  page_urls: string[];
  // Shown to the team in the channel, so it says what to fix.
  reason: string;
}

export interface DeadLinksResult {
  sent: { username: string; pages: number; links: number }[];
  unresolved: UnresolvedCopydoc[];
  room_notified: boolean;
  // True when no direct messages were sent on purpose: the config switch is
  // off or the request asked for a dry run.
  dry_run: boolean;
  resolved_owners: number;
}

// Keep messages readable and under Mattermost's post size limit.
const MAX_LINKS_PER_PAGE = 20;
const MAX_PAGES_PER_DM = 10;
const MAX_UNRESOLVED_IN_ROOM = 30;

// Page content and link results come from the open web, so they are escaped
// before going into a message: nobody should be able to plant a markdown link
// or a mention in a DM that the bot sends.
function clean(text: string, maxLength = 200): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const short =
    flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
  return short.replace(/([\\`*_{}[\]()#+!|~<>])/g, "\\$1");
}

// URLs are shown as typed so they stay clickable; only whitespace and control
// characters are dropped, which also keeps them on one line.
function plainUrl(url: string): string {
  return url.replace(/[\u0000-\u0020\u007f]+/g, "").slice(0, 300);
}

type Resolution = { user: MmUser } | { reason: string };

// Finds the one Mattermost user with exactly this full name. Searching alone
// is not enough: Mattermost returns loose matches, and messaging the wrong
// person is worse than reporting the copydoc as unresolved, so anything but a
// single exact match is rejected.
async function findUserByName(
  name: string,
  deps: DeadLinksDeps,
): Promise<Resolution> {
  const wanted = normalizeName(name);
  // The accent-free spelling is tried too, since a search for "Saglam" may
  // not find "Sağlam" (and the other way round).
  const terms = [name];
  if (wanted !== name) {
    terms.push(wanted);
  }

  for (const term of terms) {
    const matches = (await deps.searchUsers(term)).filter(
      (user) =>
        // Never message bots or people who have left.
        !user.is_bot &&
        !user.delete_at &&
        normalizeName(`${user.first_name} ${user.last_name}`) === wanted,
    );
    if (matches.length === 1) {
      return { user: matches[0]! };
    }
    if (matches.length > 1) {
      return { reason: `several Mattermost users are named '${name}'` };
    }
  }
  return { reason: `no Mattermost user is named '${name}'` };
}

// An email identifies a person exactly, so it is tried first. The name is a
// fallback for a chip whose email has no Mattermost account, and for owners
// typed as plain text.
async function lookupUser(
  owner: PageOwner,
  deps: DeadLinksDeps,
): Promise<Resolution> {
  try {
    if (owner.email) {
      const user = await deps.findUserByEmail(owner.email);
      if (user) {
        return { user };
      }
      if (!owner.name) {
        return { reason: `no Mattermost user has email ${owner.email}` };
      }
    }
    return await findUserByName(owner.name ?? "", deps);
  } catch (error) {
    logger.error("Mattermost user lookup failed", error);
    return { reason: "the Mattermost user lookup failed" };
  }
}

// Works out who owns a copydoc. Every way this can fail gets its own reason,
// because the reason is what the team reads in the channel.
async function resolveOwner(
  copydocUrl: string | null,
  deps: DeadLinksDeps,
  userCache: Map<string, Promise<Resolution>>,
): Promise<Resolution> {
  if (!copydocUrl) {
    return { reason: "the page has no copydoc" };
  }
  // Pages with no copydoc of their own point at the site's default Drive
  // folder, which has no owner.
  const docId = extractDocId(copydocUrl);
  if (!docId) {
    return { reason: "the copydoc is a folder, not a document" };
  }

  let owner: PageOwner | null;
  try {
    owner = await deps.getPageOwner(docId);
  } catch (error) {
    if (deps.isDocAccessError(error)) {
      return { reason: "the bot cannot read the copydoc" };
    }
    // Anything else (network, quota) is a failure of ours, not of the doc.
    logger.error(`Failed to read copydoc ${docId}`, error);
    return { reason: "reading the copydoc failed" };
  }
  if (!owner) {
    return { reason: "the copydoc does not list a page owner" };
  }

  // Many copydocs share an owner; look each one up once per request.
  const key = `${owner.email ?? ""}|${normalizeName(owner.name ?? "")}`;
  let pending = userCache.get(key);
  if (!pending) {
    pending = lookupUser(owner, deps);
    userCache.set(key, pending);
  }
  return pending;
}

// One DM per owner, listing every page they own with its broken links.
function buildDirectMessage(
  user: MmUser,
  pages: PageReport[],
  runUrl?: string,
): string {
  const greeting = user.first_name ? `Hi ${clean(user.first_name)},` : "Hi,";
  const run = runUrl ? ` ([run](${plainUrl(runUrl)}))` : "";
  const lines = [
    `${greeting} the link checker${run} found broken links on pages that list you as the page owner:`,
  ];

  for (const page of pages.slice(0, MAX_PAGES_PER_DM)) {
    const copydoc = page.copydoc_url
      ? ` ([copydoc](${plainUrl(page.copydoc_url)}))`
      : "";
    lines.push("", `**${plainUrl(page.page_url)}**${copydoc}`);
    for (const link of page.broken_links.slice(0, MAX_LINKS_PER_PAGE)) {
      const result = link.result ? ` (${clean(link.result, 80)})` : "";
      lines.push(`- ${plainUrl(link.url)}${result}`);
    }
    const hidden = page.broken_links.length - MAX_LINKS_PER_PAGE;
    if (hidden > 0) {
      lines.push(`- and ${hidden} more`);
    }
  }
  const hiddenPages = pages.length - MAX_PAGES_PER_DM;
  if (hiddenPages > 0) {
    lines.push("", `and ${hiddenPages} more pages`);
  }
  return lines.join("\n");
}

// The channel message names copydocs, not owners, so it does not depend on
// who would have been messaged.
function buildRoomMessage(
  unresolved: UnresolvedCopydoc[],
  payload: DeadLinksPayload,
): string {
  const runUrl = payload.run_url;
  const run = runUrl ? ` ([run](${plainUrl(runUrl)}))` : "";
  const lines = [
    `The link checker${run} found broken links, but no page owner could be notified for these copydocs:`,
  ];

  for (const item of unresolved.slice(0, MAX_UNRESOLVED_IN_ROOM)) {
    const copydoc = item.copydoc_url
      ? `[copydoc](${plainUrl(item.copydoc_url)})`
      : "no copydoc";
    lines.push("", `- ${copydoc}: ${item.reason}`);
    for (const pageUrl of item.page_urls) {
      lines.push(`  - ${plainUrl(pageUrl)}`);
    }
  }
  const hidden = unresolved.length - MAX_UNRESOLVED_IN_ROOM;
  if (hidden > 0) {
    lines.push("", `and ${hidden} more copydocs`);
  }
  const omittedPages = payload.omitted_pages ?? 0;
  const omittedLinks = payload.omitted_links ?? 0;
  if (omittedPages > 0 || omittedLinks > 0) {
    lines.push(
      "",
      `The report was too large to send in full: ${omittedPages} pages and ${omittedLinks} links were left out.`,
    );
  }
  return lines.join("\n");
}

// Never throws for a single bad page or user: each failure is recorded in
// `unresolved` and the rest of the report is still processed. DMs are skipped
// for a dry run (switched off in the config, or asked for by the request), but
// owners are still looked up so the result shows how many were found and which
// copydocs need fixing.
export async function processDeadLinks(
  payload: DeadLinksPayload,
  deps: DeadLinksDeps,
  { sendDirectMessages = true }: { sendDirectMessages?: boolean } = {},
): Promise<DeadLinksResult> {
  // Direct messages need both the config and the request to allow them.
  const dryRun = !sendDirectMessages || payload.dry_run === true;
  // Owners are looked up once each, even when they own many copydocs.
  const userCache = new Map<string, Promise<Resolution>>();
  // Pages that share a copydoc share an owner, so read each copydoc once.
  const byCopydoc = new Map<string, PageReport[]>();
  for (const page of payload.pages) {
    const key = page.copydoc_url ?? "";
    byCopydoc.set(key, [...(byCopydoc.get(key) ?? []), page]);
  }

  const unresolved: UnresolvedCopydoc[] = [];
  const byUser = new Map<string, { user: MmUser; pages: PageReport[] }>();

  // Step 1: find the owner of every copydoc, and group pages by owner.
  for (const [key, pages] of byCopydoc) {
    const copydocUrl = key || null;
    const resolution = await resolveOwner(copydocUrl, deps, userCache);
    if ("reason" in resolution) {
      unresolved.push({
        copydoc_url: copydocUrl,
        page_urls: pages.map((page) => page.page_url),
        reason: resolution.reason,
      });
      continue;
    }
    const entry = byUser.get(resolution.user.id) ?? {
      user: resolution.user,
      pages: [],
    };
    entry.pages.push(...pages);
    byUser.set(resolution.user.id, entry);
  }

  // Step 2: send each owner one DM.
  const sent: DeadLinksResult["sent"] = [];
  const recipients = dryRun ? [] : [...byUser.values()];
  for (const { user, pages } of recipients) {
    try {
      await deps.sendDirectMessage(
        user.id,
        buildDirectMessage(user, pages, payload.run_url),
      );
      sent.push({
        username: user.username,
        pages: pages.length,
        links: pages.reduce((n, page) => n + page.broken_links.length, 0),
      });
    } catch (error) {
      logger.error(`Failed to DM ${user.username}`, error);
      // Backticks, not an @mention: this lands in a public channel.
      unresolved.push({
        copydoc_url: pages[0]?.copydoc_url ?? null,
        page_urls: pages.map((page) => page.page_url),
        reason: `sending a direct message to \`${user.username}\` failed`,
      });
    }
  }

  // Step 3: tell the channel about everything that could not be delivered.
  let roomNotified = false;
  if (unresolved.length > 0) {
    try {
      await deps.sendToRoom(payload.room, buildRoomMessage(unresolved, payload));
      roomNotified = true;
    } catch (error) {
      logger.error(`Failed to post to room ${payload.room}`, error);
    }
  }

  return {
    sent,
    unresolved,
    room_notified: roomNotified,
    dry_run: dryRun,
    resolved_owners: byUser.size,
  };
}
