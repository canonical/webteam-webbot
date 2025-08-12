import { logger } from "../../utils/logger";
import config from "../../config";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { Router } from "express";

export const router = Router();

router.post("/acronym", async (req, res): Promise<void> => {
  try {
    const { token, text } = req.body;

    const serviceAccountAuth = new JWT({
      email: config.google_sheets.client_email,
      key: config.google_sheets.private_key?.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    if (token !== config.mattermost.commands.acronym_token) {
      res.status(401).send("Unauthorized");
      return;
    }

    let result = `Format: \`/acronym <acronym>\` eg. \`/acronym usn\`. Add your own [here](https://docs.google.com/spreadsheets/d/${config.google_sheets.spreadsheet_id})`;

    if (text && text.trim() !== "help") {
      const acronym = text.toUpperCase().trim();

      try {
        const doc = new GoogleSpreadsheet(
          config.google_sheets.spreadsheet_id,
          serviceAccountAuth
        );
        await doc.loadInfo();

        const sheet = doc.sheetsByIndex[0];
        if (!sheet) {
          throw new Error("No sheet found in the spreadsheet");
        }
        const rows = await sheet.getRows();

        const responses = rows.filter(
          (row) =>
            row.get("Acronym") &&
            row.get("Acronym").toUpperCase().trim() === acronym
        );

        let textResult = "";
        responses.forEach((response) => {
          if (textResult) textResult += "\n";
          const link = response.get("Link") || "";
          const definition = response.get("Definition") || "";
          textResult += `${response.get("Acronym")}: ${definition} ${link}`;
        });

        result =
          textResult ||
          `This acronym doesn't exist (yet!). Add your own [here](https://docs.google.com/spreadsheets/d/${config.google_sheets.spreadsheet_id})`;
      } catch (error) {
        logger.error("Acronym lookup error:", error);
        result = "Error looking up acronym. Please try again later.";
      }
    }

    res.setHeader("content-type", "application/json");
    res.send(
      JSON.stringify({
        response_type: "ephemeral",
        text: result,
      })
    );
  } catch (error) {
    logger.error("Acronym endpoint error:", error);
    res.status(500).send("Internal server error");
  }
});

router.post("/explain", async (req, res): Promise<void> => {
  try {
    const { token, text } = req.body;

    const serviceAccountAuth = new JWT({
      email: config.google_sheets.client_email,
      key: config.google_sheets.private_key?.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    if (token !== config.mattermost.commands.explain_token) {
      res.status(401).send("Unauthorized");
      return;
    }

    const usage = `Format: \`/explain <concept>\` eg. \`/explain MAAS\`. If you want to see the top 5 unexplained terms try '/explain top-5'. Add your own [here](https://docs.google.com/spreadsheets/d/${config.google_sheets.spreadsheet_id}/edit#gid=2064544629)`;

    if (!text || text.trim().match(/^(-)*h(elp)?$/gi)) {
      res.json({ response_type: "ephemeral", text: usage });
      return;
    }

    try {
      const doc = new GoogleSpreadsheet(
        config.google_sheets.spreadsheet_id,
        serviceAccountAuth
      );
      await doc.loadInfo();

      let result = usage;

      if (text.toLowerCase().trim() === "top-5") {
        const unexplainedSheet = doc.sheetsByTitle["Unexplained"];
        if (unexplainedSheet) {
          const rows = await unexplainedSheet.getRows();
          const sorted = rows.sort(
            (a, b) =>
              parseInt(b.get("Count") || "0") - parseInt(a.get("Count") || "0")
          );
          const top5 = sorted.slice(0, 5);

          result = "Top 5 unexplained terms. Format: '<term>(count)' ";
          top5.forEach((u) => {
            result += ` - '${u.get("Explain")}(${u.get("Count")})'`;
          });
          result += `. If you can explain any of these terms or want to add your own [here](https://docs.google.com/spreadsheets/d/${config.google_sheets.spreadsheet_id}/edit#gid=2064544629)`;
        }
      } else {
        const sheet = doc.sheetsByTitle["Explain"];
        if (sheet) {
          const rows = await sheet.getRows();

          const searchQuery = text.toLowerCase().trim();
          const row = rows.find((row) => {
            const explain = (row.get("Explain") || "").toLowerCase().trim();
            const alias = (row.get("Alias") || "").toLowerCase().trim();
            return (
              explain === searchQuery ||
              alias
                .split(",")
                .map((e: string) => e.trim())
                .includes(searchQuery)
            );
          });

          if (row) {
            // Increment count
            const currentCount = parseInt(row.get("Count") || "0");
            row.set("Count", (currentCount + 1).toString());
            await row.save();
            console.log("Saved");

            // Format response as markdown table
            result = `| Title | Description |\n|--|--|\n`;
            result += `| ${row.get("Explain")} | ${row.get("Definition")} |\n`;

            const pm = row.get("PM");
            if (pm && pm.toLowerCase() !== "n/a") {
              result += `| PM | ${pm} |\n`;
            }

            const team = row.get("Team");
            if (team && team.toLowerCase() !== "n/a") {
              result += `| Team | ${team} |\n`;
            }

            const contact = row.get("Contact");
            if (contact && contact.toLowerCase() !== "n/a") {
              result += `| Contact channel | ${contact} |\n`;
            }

            const link = row.get("Link");
            if (link && link.toLowerCase() !== "n/a") {
              result += `| Read more | ${link} |\n`;
            }
          } else {
            // Add to unexplained sheet
            const unexplainedSheet = doc.sheetsByTitle["Unexplained"];
            if (unexplainedSheet) {
              const unexplainedRows = await unexplainedSheet.getRows();
              const existingRow = unexplainedRows.find(
                (row) =>
                  (row.get("Explain") || "").toLowerCase().trim() ===
                  searchQuery
              );

              if (existingRow) {
                const currentCount = parseInt(existingRow.get("Count") || "0");
                existingRow.set("Count", (currentCount + 1).toString());
                await existingRow.save();
              } else {
                await unexplainedSheet.addRow({ Explain: text, Count: "1" });
              }
            }
            result = `I don't know what '${text}' means. If you can explain it, please add your explanation [here](https://docs.google.com/spreadsheets/d/${config.google_sheets.spreadsheet_id}/edit#gid=2064544629)`;
          }
        }
      }

      res.json({ response_type: "ephemeral", text: result });
    } catch (error) {
      logger.error("Explain lookup error:", error);
      res.json({
        response_type: "ephemeral",
        text: "Error looking up explanation. Please try again later.",
      });
    }
  } catch (error) {
    logger.error("Explain endpoint error:", error);
    res.status(500).send("Internal server error");
  }
});

router.post("/dir", async (req, res): Promise<void> => {
  try {
    const { token, text } = req.body;

    if (token !== config.mattermost.commands.dir_token) {
      res.status(401).send("Unauthorized");
      return;
    }

    let result: string;

    if (text) {
      result =
        "https://directory.canonical.com/search?query=" +
        encodeURIComponent(text.trim());
    } else {
      result = "https://directory.canonical.com";
    }

    res.setHeader("content-type", "application/json");
    res.send(
      JSON.stringify({
        response_type: "ephemeral",
        text: result,
      })
    );
  } catch (error) {
    logger.error("Directory endpoint error:", error);
    res.status(500).send("Internal server error");
  }
});

router.post("/meet", async (req, res): Promise<void> => {
  try {
    const { token, text, user_name } = req.body;

    if (token !== config.mattermost.commands.meet_token) {
      res.status(401).send("Unauthorized");
      return;
    }

    let result = `Create a new Meet and post the link to the current channel, format: \`/meet @{username} [@{username} ...]\``;
    let fallbackText = result;

    if (text && text.trim() !== "help") {
      const code = text.replace(/@/g, "").replace(/ /g, "-").slice(0, 59);
      const link = `https://meet.google.com/lookup/${code}`;

      result =
        `| ![Meet](https://assets.ubuntu.com/v1/f6017d02-mattermeet36px.png "Mattermeet icon") [Join Meet](${link}) |\n` +
        `|:---------------|\n` +
        `| **Attendees:** ${user_name} ${text} |\n` +
        `|  | `;

      fallbackText = `${user_name} created a new Meet with ${text}`;
    }

    res.setHeader("content-type", "application/json");
    res.send(
      JSON.stringify({
        response_type: "in_channel",
        icon_url: "https://assets.ubuntu.com/v1/fa583301-meet-bot-logo.png",
        text: result,
        fallback: fallbackText,
      })
    );
  } catch (error) {
    logger.error("Meet endpoint error:", error);
    res.status(500).send("Internal server error");
  }
});
