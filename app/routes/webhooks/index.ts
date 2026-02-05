import { Router } from "express";
import { router as commandsRouter } from "./commands";
import { router as alertsRouter } from "./alerts";
import { router as githubRouter } from "./github";
import { router as releaseRouter } from "./release";
import { router as figmaRouter } from "./figma";
import { router as snapReportsRouter } from "./snapReports";

const router = Router();

router.use(commandsRouter);
router.use(alertsRouter);
router.use(githubRouter);
router.use(releaseRouter);
router.use(figmaRouter);
router.use(snapReportsRouter);

export { router as webhooksRouter };
