import { GoogleAuth, JWTOptions } from "google-auth-library";
import { HttpsProxyAgent } from "https-proxy-agent";
import config from "../config";
import { logger } from "../utils/logger";
import { DocsDocument, findPageOwner, PageOwner } from "../utils/copydoc";
import { buildCredentials } from "../utils/googleCredentials";

// Reads copydocs with a service account that the docs are shared with. Only
// the read-only Docs scope is requested, so the bot cannot edit any document.
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
const REQUEST_TIMEOUT_MS = 15_000;
// The Docs API limits reads per minute; one patient retry is enough here.
const RATE_LIMIT_WAIT_MS = 5_000;

// The doc is missing or not shared with the bot's service account. Google
// answers 404 for a doc the account cannot see, so both mean "cannot read".
export class DocAccessError extends Error {}

// Built on first use, so the bot starts fine without Google credentials.
let auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!auth) {
    // Fetching the access token goes through its own HTTP client, so the proxy
    // has to be set here as well as on the API request in fetchDocument().
    const clientOptions: JWTOptions | undefined = process.env.HTTPS_PROXY
      ? {
          transporterOptions: {
            agent: new HttpsProxyAgent(process.env.HTTPS_PROXY),
          },
        }
      : undefined;
    auth = new GoogleAuth({
      credentials: buildCredentials(config.google_docs),
      scopes: [DOCS_SCOPE],
      clientOptions,
    });
  }
  return auth;
}

function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } }).response?.status;
}

async function fetchDocument(docId: string): Promise<DocsDocument> {
  const request = () =>
    getAuth().request<DocsDocument>({
      url: `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
      timeout: REQUEST_TIMEOUT_MS,
      ...(process.env.HTTPS_PROXY && {
        agent: new HttpsProxyAgent(process.env.HTTPS_PROXY),
      }),
    });

  try {
    return (await request()).data;
  } catch (error) {
    if (statusOf(error) !== 429) {
      throw error;
    }
    logger.warn(`Docs API rate limit hit reading ${docId}, retrying`);
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
    return (await request()).data;
  }
}

// Returns null when the doc has no readable owner row. Throws DocAccessError
// when the doc cannot be read, and rethrows anything else (network, quota).
export async function getPageOwner(docId: string): Promise<PageOwner | null> {
  try {
    return findPageOwner(await fetchDocument(docId));
  } catch (error) {
    const status = statusOf(error);
    if (status === 403 || status === 404) {
      logger.warn(`Copydoc ${docId} is not readable (HTTP ${status})`);
      throw new DocAccessError(`HTTP ${status}`);
    }
    throw error;
  }
}
