import { describe, expect, test } from "bun:test";
import {
  DeadLinksDeps,
  DeadLinksPayload,
  MmUser,
  processDeadLinks,
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
