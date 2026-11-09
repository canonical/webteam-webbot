import { describe, expect, test } from "bun:test";
import {
  DocsDocument,
  extractDocId,
  findPageOwner,
  normalizeName,
  parseOwnerName,
} from "../utils/copydoc";

function ownerDoc(
  valueCell: object[],
  label = "*Page owner (writer and department)\n",
): DocsDocument {
  const cell = (elements: object[]) => ({
    content: [{ paragraph: { elements } }],
  });
  return {
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: "intro\n" } }] } },
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  cell([{ textRun: { content: "Page title\n" } }]),
                  cell([{ textRun: { content: "Demo\n" } }]),
                ],
              },
              {
                tableCells: [
                  cell([{ textRun: { content: label } }]),
                  cell(valueCell),
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

const text = (content: string) => ({ textRun: { content } });

describe("extractDocId", () => {
  test("reads the id from document URLs", () => {
    expect(
      extractDocId(
        "https://docs.google.com/document/d/1sYHH24-fz_Hk/edit?tab=t.0",
      ),
    ).toBe("1sYHH24-fz_Hk");
  });

  test("returns null for folders and empty values", () => {
    expect(
      extractDocId("https://drive.google.com/drive/folders/0B4s80"),
    ).toBeNull();
    expect(extractDocId(null)).toBeNull();
  });
});

describe("parseOwnerName", () => {
  test.each([
    ["Jane Doe, Web Engineering\n", "Jane Doe"],
    ["Jane Doe/Web Engineering\n", "Jane Doe"],
    ["Jane Doe / Marketing", "Jane Doe"],
    ["  Jane   Doe \n", "Jane Doe"],
    ["", ""],
  ])("%j gives %j", (input, expected) => {
    expect(parseOwnerName(input)).toBe(expected);
  });
});

describe("normalizeName", () => {
  test("ignores case, accents and spacing", () => {
    expect(normalizeName("  Atakan  SAĞLAM ")).toBe("atakan saglam");
  });
});

describe("findPageOwner", () => {
  test("uses the email of a person chip", () => {
    const doc = ownerDoc([
      {
        person: {
          personProperties: { name: "Jane Doe", email: "jane.doe@example.com" },
        },
      },
      text("\n"),
    ]);
    expect(findPageOwner(doc)).toEqual({
      email: "jane.doe@example.com",
      name: "Jane Doe",
    });
  });

  test("reads a plain name with a comma and department", () => {
    expect(
      findPageOwner(ownerDoc([text("Jane Doe, Web Engineering\n")])),
    ).toEqual({
      name: "Jane Doe",
    });
  });

  test("reads a plain name with a slash and no spaces", () => {
    expect(
      findPageOwner(ownerDoc([text("Jane Doe/Web Engineering\n")])),
    ).toEqual({
      name: "Jane Doe",
    });
  });

  test("reads a bare full name", () => {
    expect(findPageOwner(ownerDoc([text("Jane Doe\n")]))).toEqual({
      name: "Jane Doe",
    });
  });

  test("returns null when the owner cell is empty", () => {
    expect(findPageOwner(ownerDoc([text("\n")]))).toBeNull();
  });

  test("returns null when there is no owner row", () => {
    expect(findPageOwner(ownerDoc([text("Jane\n")], "Author\n"))).toBeNull();
    expect(findPageOwner({})).toBeNull();
  });
});
