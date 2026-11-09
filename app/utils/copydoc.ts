// Pure helpers for reading the "Page owner" row of a copydoc (Google Doc).
//
// A copydoc starts with a metadata table whose rows are label/value pairs. The
// "Page owner" value is either a person chip (which carries an email) or typed
// text such as "Jane Doe / Marketing", "Jane Doe, Marketing" or "Jane Doe".

// Only the parts of the Google Docs API document shape that we read.
export interface ParagraphElement {
  textRun?: { content?: string };
  person?: { personProperties?: { name?: string; email?: string } };
}

export interface StructuralElement {
  paragraph?: { elements?: ParagraphElement[] };
  table?: {
    tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[];
  };
}

export interface DocsDocument {
  body?: { content?: StructuralElement[] };
}

export interface PageOwner {
  // Set when the owner is a person chip; the most reliable way to find them.
  email?: string;
  // The chip's display name, or the name typed in the cell.
  name?: string;
}

// Copydocs keep the owner in the metadata table at the top of the doc.
const MAX_TABLES_TO_SCAN = 3;

// Copydoc URLs look like https://docs.google.com/document/d/<id>/edit?tab=...
// Folder URLs (the site's default copydoc) have no document id, so give null.
export function extractDocId(url: string | null | undefined): string | null {
  const match = url?.match(/\/document\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

// For comparing a name typed in a copydoc with a Mattermost profile name:
// ignores case, accents ("Sağlam" matches "Saglam") and repeated spaces.
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// The department or title follows the name after a slash or a comma, so the
// name is everything before the first of them.
// "Jane Doe / Marketing", "Jane Doe, Marketing" and "Jane Doe" all give "Jane Doe".
export function parseOwnerName(text: string): string {
  const [name = ""] = text.split(/[/,]/, 1);
  return name.replace(/\s+/g, " ").trim();
}

// Flattens a table cell into its typed text plus the first person chip in it.
function cellParts(content: StructuralElement[] | undefined): {
  text: string;
  email?: string;
  name?: string;
} {
  let text = "";
  let email: string | undefined;
  let name: string | undefined;

  for (const element of content ?? []) {
    for (const part of element.paragraph?.elements ?? []) {
      if (part.textRun?.content) {
        text += part.textRun.content;
      }
      const person = part.person?.personProperties;
      if (person && !email) {
        email = person.email;
        name = person.name;
      }
    }
  }

  return { text, email, name };
}

// Returns null when the doc has no "Page owner" row or its value is empty.
// A person chip wins over typed text, because an email identifies the person
// exactly while a typed name may be ambiguous.
export function findPageOwner(doc: DocsDocument): PageOwner | null {
  let tablesSeen = 0;

  for (const element of doc.body?.content ?? []) {
    if (!element.table) {
      continue;
    }
    if (++tablesSeen > MAX_TABLES_TO_SCAN) {
      break;
    }

    for (const row of element.table.tableRows ?? []) {
      const [labelCell, valueCell] = row.tableCells ?? [];
      if (!labelCell || !valueCell) {
        continue;
      }
      // The label reads e.g. "*Page owner (writer and department)".
      if (!/page owner/i.test(cellParts(labelCell.content).text)) {
        continue;
      }

      const value = cellParts(valueCell.content);
      if (value.email) {
        return { email: value.email, name: value.name };
      }
      const name = parseOwnerName(value.text);
      return name ? { name } : null;
    }
  }

  return null;
}
