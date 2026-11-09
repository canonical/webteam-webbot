import { describe, expect, test } from "bun:test";
import { buildCredentials } from "../utils/googleCredentials";

const account = {
  type: "service_account",
  project_id: "project",
  private_key: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----\\n",
  client_email: "bot@project.iam.gserviceaccount.com",
  client_id: "123",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("buildCredentials", () => {
  test("turns escaped newlines in the key into real ones", () => {
    expect(buildCredentials(account).private_key).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
    );
  });

  test("keeps the other fields", () => {
    expect(buildCredentials(account)).toMatchObject({
      type: "service_account",
      client_email: account.client_email,
      client_id: "123",
      token_uri: account.token_uri,
    });
  });

  test.each([
    ["missing section", undefined],
    ["empty key", { ...account, private_key: "" }],
    ["empty email", { ...account, client_email: "" }],
  ])("rejects a %s", (_label, input) => {
    expect(() => buildCredentials(input)).toThrow("not configured");
  });
});
