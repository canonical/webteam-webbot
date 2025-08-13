import { Router } from "express";
import { router as commandsRouter } from "./commands";
import { router as alertsRouter } from "./alerts";
import { router as githubRouter } from "./github";
import { router as releaseRouter } from "./release";

const router = Router();

router.use(commandsRouter);
router.use(alertsRouter);
router.use(githubRouter);
router.use(releaseRouter);

export { router as webhooksRouter };
