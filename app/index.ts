import express from "express";
import cors from "cors";
import helmet from "helmet";
import { logger } from "./utils/logger";
import config from "./config";
import { requestLogger } from "./middleware/requestLogger";
import { webhooksRouter } from "./routes/webhooks";
import { MattermostService } from "./services/mattermost";
import { ChatCommandService } from "./services/chatCommands";
import multer from "multer";
import { homeRouter } from "./routes/index";

async function startServer(): Promise<void> {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(multer().none());
  app.use(requestLogger);
  app.get("/_status/check", (req, res) => {
    res.status(200).send("OK");
  });
  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      logger.error("Unhandled error", err);
      res.status(500).json({ error: "Internal server error" });
    }
  );

  const mattermostService = new MattermostService(config.mattermost);
  await mattermostService.initialize();

  const chatCommandService = new ChatCommandService(mattermostService);

  mattermostService.addMessageHandler(
    chatCommandService.handleMessage.bind(chatCommandService)
  );

  app.locals.mattermostService = mattermostService;

  app.use("/webhooks", webhooksRouter);
  app.use("/hubot", webhooksRouter); // For legacy support
  app.use("/", homeRouter);

  const port = config.server.port;
  app.listen(port, () => {
    logger.info(`webbot server started on port ${port}`);
  });
}

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at", promise, "reason:", reason);
  process.exit(1);
});

startServer().catch((error) => {
  logger.error("Failed to start server", error);
  process.exit(1);
});
