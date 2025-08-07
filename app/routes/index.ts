import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  res.send("Canonical Webbot");
});

export { router as homeRouter };
