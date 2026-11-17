import { describe, expect, test } from "bun:test";
import {
  DeadLinksDeps,
  DeadLinksPayload,
  MmUser,
  processDeadLinks,
  splitMessage,
} from "../services/deadLinks";

const user = (
  id: string,
  first: string,
  extra: Partial<MmUser> = {},
): MmUser => ({
  id,
  username: first.toLowerCase(),
  first_name: first,
  last_name: "",
  ...extra,
});

const DOC_A = "https://docs.google.com/document/d/docA/edit";
const DOC_B = "https://docs.google.com/document/d/docB/edit";

function page(url: string, copydoc: string | null, links = 1) {
  return {
    page_url: url,
    copydoc_url: copydoc,
    broken_links: Array.from({ length: links }, (_, i) => ({
      url: `https://dead.example/${i}`,
      result: "404 Not Found",
    })),
  };
}

function makeDeps(overrides: Partial<DeadLinksDeps> = {}) {
  const dms: { userId: string; message: string }[] = [];
  const rooms: { room: string; message: string }[] = [];
  const deps: DeadLinksDeps = {
    getPageOwner: async () => ({ name: "Jane Doe" }),
    isDocAccessError: () => false,
    findUserByEmail: async () => null,
    searchUsers: async () => [user("u1", "Jane Doe")],
    sendDirectMessage: async (userId, message) => {
      dms.push({ userId, message });
    },
    sendToRoom: async (room, message) => {
      rooms.push({ room, message });
    },
    ...overrides,
  };
  return { deps, dms, rooms };
}

const payload = (pages: DeadLinksPayload["pages"]): DeadLinksPayload => ({
  room: "test-room",
  run_url: "https://github.com/run/1",
  pages,
});

describe("processDeadLinks", () => {
  test("sends one DM per owner covering all of their pages", async () => {
    const { deps, dms, rooms } = makeDeps();
    const result = await processDeadLinks(
      payload([
        page("https://ubuntu.com/a", DOC_A),
        page("https://ubuntu.com/b", DOC_B),
      ]),
      deps,
    );

    expect(dms).toHaveLength(1);
    expect(dms[0]!.message).toContain("https://ubuntu.com/a");
    expect(dms[0]!.message).toContain("https://ubuntu.com/b");
    expect(result.sent).toEqual([{ username: "jane doe", pages: 2, links: 2 }]);
    expect(result.unresolved).toEqual([]);
    expect(rooms).toHaveLength(0);
  });

  test("prefers the email over the name", async () => {
    const { deps, dms } = makeDeps({
      getPageOwner: async () => ({
        email: "jane@example.com",
        name: "Someone Else",
      }),
      findUserByEmail: async () => user("u9", "Jane"),
    });
    await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(dms[0]!.userId).toBe("u9");
  });

  test("matches names ignoring accents and skips bots and deactivated users", async () => {
    const { deps, dms } = makeDeps({
      getPageOwner: async () => ({ name: "Atakan Saglam" }),
      searchUsers: async () => [
        { ...user("bot", "Atakan"), last_name: "Sağlam", is_bot: true },
        { ...user("old", "Atakan"), last_name: "Sağlam", delete_at: 5 },
        { ...user("u2", "Atakan"), last_name: "Sağlam" },
      ],
    });
    await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(dms.map((dm) => dm.userId)).toEqual(["u2"]);
  });

  test.each<[string, string | null, Partial<DeadLinksDeps>, string]>([
    ["no copydoc", null, {}, "no copydoc"],
    [
      "a folder copydoc",
      "https://drive.google.com/drive/folders/x",
      {},
      "folder",
    ],
    [
      "no owner row",
      DOC_A,
      { getPageOwner: async () => null },
      "does not list a page owner",
    ],
    [
      "unreadable doc",
      DOC_A,
      {
        getPageOwner: async (): Promise<null> => {
          throw new Error("denied");
        },
        isDocAccessError: () => true,
      },
      "cannot read the copydoc",
    ],
    [
      "unknown name",
      DOC_A,
      { searchUsers: async () => [] },
      "no Mattermost user is named",
    ],
    [
      "ambiguous name",
      DOC_A,
      {
        searchUsers: async () => [user("a", "Jane Doe"), user("b", "Jane Doe")],
      },
      "several Mattermost users",
    ],
  ])(
    "lists the copydoc in the room when %s",
    async (_label, copydoc, overrides, reason) => {
      const { deps, dms, rooms } = makeDeps(overrides);
      const result = await processDeadLinks(
        payload([page("https://ubuntu.com/a", copydoc)]),
        deps,
      );

      expect(dms).toHaveLength(0);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]!.reason).toContain(reason);
      expect(result.room_notified).toBe(true);
      expect(rooms).toHaveLength(1);
      expect(rooms[0]!.room).toBe("test-room");
      expect(rooms[0]!.message).toContain("https://ubuntu.com/a");
    },
  );

  test("groups pages that share a copydoc into one room entry", async () => {
    const { deps, rooms } = makeDeps({ searchUsers: async () => [] });
    const result = await processDeadLinks(
      payload([
        page("https://ubuntu.com/a", DOC_A),
        page("https://ubuntu.com/b", DOC_A),
      ]),
      deps,
    );
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!.page_urls).toHaveLength(2);
    expect(rooms[0]!.message.match(/copydoc\]/g)).toHaveLength(1);
  });

  test("reports a failed DM in the room and still handles other owners", async () => {
    const { deps, rooms } = makeDeps({
      sendDirectMessage: async () => {
        throw new Error("boom");
      },
    });
    const result = await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(result.sent).toEqual([]);
    expect(result.unresolved[0]!.reason).toContain("direct message");
    expect(rooms).toHaveLength(1);
  });

  test("caps the links listed per page", async () => {
    const { deps, dms } = makeDeps();
    await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A, 25)]),
      deps,
    );
    expect(dms[0]!.message).toContain("and 5 more");
  });

  test("escapes markdown in link results", async () => {
    const { deps, dms } = makeDeps();
    const crafted = page("https://ubuntu.com/a", DOC_A);
    crafted.broken_links[0]!.result = "[click](http://evil.example)";
    await processDeadLinks(payload([crafted]), deps);
    expect(dms[0]!.message).not.toContain("[click](http");
  });

  test("names a failed DM recipient without pinging them", async () => {
    const { deps, rooms } = makeDeps({
      sendDirectMessage: async () => {
        throw new Error("boom");
      },
    });
    await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(rooms[0]!.message).not.toContain("@");
  });

  test("looks up an owner shared by several copydocs once", async () => {
    let searches = 0;
    const { deps, dms } = makeDeps({
      searchUsers: async () => {
        searches++;
        return [user("u1", "Jane Doe")];
      },
    });
    await processDeadLinks(
      payload([
        page("https://ubuntu.com/a", DOC_A),
        page("https://ubuntu.com/b", DOC_B),
      ]),
      deps,
    );
    expect(searches).toBe(1);
    expect(dms).toHaveLength(1);
  });

  test("mentions pages and links left out of the report", async () => {
    const { deps, rooms } = makeDeps({ searchUsers: async () => [] });
    await processDeadLinks(
      {
        ...payload([page("https://ubuntu.com/a", DOC_A)]),
        omitted_pages: 7,
        omitted_links: 31,
      },
      deps,
    );
    expect(rooms[0]!.message).toContain("7 pages and 31 links were left out");
  });
});

describe("processDeadLinks with direct messages off", () => {
  const twoPages = [
    page("https://ubuntu.com/a", DOC_A),
    page("https://ubuntu.com/b", null),
  ];

  test("sends no DMs but still lists unresolved copydocs", async () => {
    const { deps, dms, rooms } = makeDeps();
    const result = await processDeadLinks(payload(twoPages), deps, {
      sendDirectMessages: false,
    });

    expect(dms).toHaveLength(0);
    expect(result.sent).toEqual([]);
    expect(result.dry_run).toBe(true);
    expect(result.resolved_owners).toBe(1);
    expect(result.unresolved).toHaveLength(1);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.message).toContain("https://ubuntu.com/b");
  });

  test("posts nothing about owners who would have been messaged", async () => {
    const { deps, rooms } = makeDeps();
    await processDeadLinks(payload(twoPages), deps, {
      sendDirectMessages: false,
    });
    expect(rooms[0]!.message).not.toContain("https://ubuntu.com/a");
    expect(rooms[0]!.message).not.toContain("jane");
  });

  test("a request dry_run overrides enabled direct messages", async () => {
    const { deps, dms, rooms } = makeDeps();
    const result = await processDeadLinks(
      { ...payload(twoPages), dry_run: true },
      deps,
      { sendDirectMessages: true },
    );
    expect(dms).toHaveLength(0);
    expect(result.dry_run).toBe(true);
    expect(rooms).toHaveLength(1);
  });

  test("posts nothing when every owner is resolved", async () => {
    const { deps, rooms } = makeDeps();
    const result = await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
      { sendDirectMessages: false },
    );
    expect(rooms).toHaveLength(0);
    expect(result.room_notified).toBe(false);
  });
});

describe("splitMessage", () => {
  test("keeps a short message in one piece", () => {
    expect(splitMessage(["one", "two"], 100)).toEqual(["one\n\ntwo"]);
  });

  test("starts a new message instead of splitting a block", () => {
    const messages = splitMessage(["a".repeat(60), "b".repeat(60)], 100);
    expect(messages).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  test("cuts a block that is longer than a post at line breaks", () => {
    const block = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    const messages = splitMessage([block], 30);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(30);
    }
    expect(messages.join("\n")).toBe(block);
  });

  test("truncates a single line longer than a post", () => {
    const [message] = splitMessage(["x".repeat(500)], 100);
    expect(message).toHaveLength(100);
  });
});

describe("processDeadLinks with long reports", () => {
  const POST_LIMIT = 16_383;

  test("splits a long DM into several that all fit a Mattermost post", async () => {
    const { deps, dms } = makeDeps();
    const pages = Array.from({ length: 10 }, (_, p) => ({
      page_url: `https://ubuntu.com/some/section/page-${p}`,
      copydoc_url: DOC_A,
      broken_links: Array.from({ length: 20 }, (_, i) => ({
        url: `https://example.com/a/fairly/long/path/to/a/resource/gone-${p}-${i}`,
        result: "404 Not Found",
      })),
    }));

    const result = await processDeadLinks(payload(pages), deps);

    expect(dms.length).toBeGreaterThan(1);
    for (const dm of dms) {
      expect(dm.message.length).toBeLessThanOrEqual(POST_LIMIT);
    }
    const all = dms.map((dm) => dm.message).join("\n");
    expect(all).toContain("gone-0-0 ");
    expect(all).toContain("gone-9-19 ");
    expect(result.sent).toEqual([{ username: "jane doe", pages: 10, links: 200 }]);
  });

  test("splits a long channel message into several that all fit a post", async () => {
    const { deps, rooms } = makeDeps();
    const pages = Array.from({ length: 30 }, (_, c) =>
      Array.from({ length: 10 }, (_, p) =>
        page(
          `https://ubuntu.com/some/section/c${c}/page-${p}`,
          `https://drive.google.com/drive/folders/f${c}`,
        ),
      ),
    ).flat();

    const result = await processDeadLinks(payload(pages), deps);

    expect(rooms.length).toBeGreaterThan(1);
    for (const room of rooms) {
      expect(room.message.length).toBeLessThanOrEqual(POST_LIMIT);
    }
    expect(result.room_notified).toBe(true);
  });
});

describe("processDeadLinks owner lookup by email", () => {
  const byEmail = (found: MmUser | null, name?: string) =>
    makeDeps({
      getPageOwner: async () => ({ email: "jane@example.com", name }),
      findUserByEmail: async () => found,
      searchUsers: async () => [user("by-name", "Jane Doe")],
    });

  test.each<[string, Partial<MmUser>]>([
    ["deactivated", { delete_at: 5 }],
    ["a bot", { is_bot: true }],
  ])("never messages %s accounts", async (_label, extra) => {
    const { deps, dms } = byEmail(user("old", "Jane", extra));
    const result = await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(dms).toHaveLength(0);
    expect(result.unresolved[0]!.reason).toContain("deactivated or a bot");
  });

  test("falls back to the name when the email's account is deactivated", async () => {
    const { deps, dms } = byEmail(
      user("old", "Jane", { delete_at: 5 }),
      "Jane Doe",
    );
    await processDeadLinks(payload([page("https://ubuntu.com/a", DOC_A)]), deps);
    expect(dms.map((dm) => dm.userId)).toEqual(["by-name"]);
  });
});

describe("processDeadLinks pages that could not be fetched", () => {
  test("says the copydoc is unknown, not missing", async () => {
    const { deps, rooms } = makeDeps();
    const failed = { ...page("https://ubuntu.com/down", null), fetch_failed: true };
    const result = await processDeadLinks(payload([failed]), deps);

    expect(result.unresolved[0]!.reason).toContain("could not be fetched");
    expect(rooms[0]!.message).not.toContain("has no copydoc");
  });

  test("keeps them apart from pages that really have no copydoc", async () => {
    const { deps } = makeDeps();
    const failed = { ...page("https://ubuntu.com/down", null), fetch_failed: true };
    const none = page("https://ubuntu.com/none", null);
    const result = await processDeadLinks(payload([failed, none]), deps);

    expect(result.unresolved.map((u) => u.reason).sort()).toEqual([
      "the page could not be fetched, so its copydoc is unknown",
      "the page has no copydoc",
    ]);
  });
});

describe("processDeadLinks widespread links", () => {
  const widespread = [
    { url: "https://dead.example/footer", result: "404 Not Found", page_count: 300 },
  ];

  test("lists them once in the channel and not in any DM", async () => {
    const { deps, dms, rooms } = makeDeps();
    const result = await processDeadLinks(
      { ...payload([page("https://ubuntu.com/a", DOC_A)]), widespread_links: widespread },
      deps,
    );

    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.message).toContain("https://dead.example/footer");
    expect(rooms[0]!.message).toContain("on 300 pages");
    expect(dms.every((dm) => !dm.message.includes("footer"))).toBe(true);
    expect(result.widespread_links).toBe(1);
  });

  test("are posted even when every owner is found and in a dry run", async () => {
    const { deps, dms, rooms } = makeDeps();
    const result = await processDeadLinks(
      { ...payload([page("https://ubuntu.com/a", DOC_A)]), widespread_links: widespread },
      deps,
      { sendDirectMessages: false },
    );

    expect(dms).toHaveLength(0);
    expect(rooms).toHaveLength(1);
    expect(result.unresolved).toEqual([]);
    expect(result.room_notified).toBe(true);
  });

  test("share one channel message with the unresolved copydocs", async () => {
    const { deps, rooms } = makeDeps({ searchUsers: async () => [] });
    await processDeadLinks(
      { ...payload([page("https://ubuntu.com/a", DOC_A)]), widespread_links: widespread },
      deps,
    );
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.message).toContain("no Mattermost user is named");
    expect(rooms[0]!.message).toContain("broken on many pages");
  });

  test("shows only the first few and counts the rest", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      url: `https://dead.example/${i}`,
      page_count: 50 - i,
    }));
    const { deps, rooms } = makeDeps();
    await processDeadLinks({ room: "r", pages: [], widespread_links: many }, deps);
    expect(rooms[0]!.message).toContain("and 5 more links");
  });
});

describe("processDeadLinks delivery failures", () => {
  const failing = async () => {
    throw new Error("mattermost down");
  };

  test("reports a failure when the channel post fails too", async () => {
    const { deps } = makeDeps({ sendDirectMessage: failing, sendToRoom: failing });
    const result = await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(result.room_notified).toBe(false);
    expect(result.delivery_failed).toBe(true);
  });

  test("is not a failure when only a DM fails and the channel is told", async () => {
    const { deps } = makeDeps({ sendDirectMessage: failing });
    const result = await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(result.delivery_failed).toBe(false);
  });

  test("is not a failure when there was nothing for the channel", async () => {
    const { deps } = makeDeps({ sendToRoom: failing });
    const result = await processDeadLinks(
      payload([page("https://ubuntu.com/a", DOC_A)]),
      deps,
    );
    expect(result.delivery_failed).toBe(false);
  });
});
