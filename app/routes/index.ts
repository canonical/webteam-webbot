import { Router } from "express";

const router = Router();

router.get("/", (_, res) => {
  res.send("Canonical Webbot");
});

export { router as homeRouter };
