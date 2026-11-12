import { describe, expect, test } from "bun:test";
import { validatePayload } from "../routes/webhooks/deadLinks";

const valid = () => ({
  room: "web-alerts",
  pages: [
    {
      page_url: "https://ubuntu.com/a",
      copydoc_url: "https://docs.google.com/document/d/x/edit",
      broken_links: [{ url: "https://dead.example/1", result: "404 Not Found" }],
    },
  ],
});

describe("validatePayload", () => {
  test("accepts a complete request", () => {
    const body = {
      ...valid(),
      run_url: "https://github.com/run/1",
      dry_run: true,
      omitted_pages: 2,
      omitted_links: 3,
      widespread_links: [{ url: "https://dead.example/f", result: "404", page_count: 30 }],
    };
    body.pages[0] = { ...body.pages[0]!, fetch_failed: false } as any;
    expect(validatePayload(body)).toBeNull();
  });

  test("accepts the optional fields being absent or null", () => {
    const body: any = valid();
    body.run_url = null;
    body.pages[0].broken_links[0].result = undefined;
    body.pages[0].copydoc_url = null;
    expect(validatePayload(body)).toBeNull();
  });

  test.each<[string, (body: any) => void, string]>([
    ["a missing room", (b) => delete b.room, "room"],
    ["a numeric run_url", (b) => (b.run_url = 12345), "run_url"],
    ["a non-boolean dry_run", (b) => (b.dry_run = "yes"), "dry_run"],
    ["a negative omitted count", (b) => (b.omitted_pages = -1), "omitted_pages"],
    ["a non-array widespread_links", (b) => (b.widespread_links = "x"), "widespread_links"],
    [
      "a widespread link without a page_count",
      (b) => (b.widespread_links = [{ url: "https://x.example" }]),
      "widespread link",
    ],
    [
      "too many widespread links",
      (b) =>
        (b.widespread_links = Array.from({ length: 101 }, () => ({
          url: "https://x.example",
          page_count: 1,
        }))),
      "at most",
    ],
    ["a non-boolean fetch_failed", (b) => (b.pages[0].fetch_failed = "no"), "fetch_failed"],
    ["an object as a link result", (b) => (b.pages[0].broken_links[0].result = { a: 1 }), "string result"],
    ["a link without a url", (b) => (b.pages[0].broken_links[0] = {}), "url"],
    ["a page without a page_url", (b) => delete b.pages[0].page_url, "page_url"],
  ])("rejects %s", (_label, mutate, expected) => {
    const body: any = valid();
    mutate(body);
    expect(validatePayload(body)).toContain(expected);
  });
});
