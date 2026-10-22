const router = require("express").Router();
const crypto = require("crypto");
const quota = require("../services/operationQuota");
router.use((req, res, next) => {
  const expected = process.env.VIDEO_INTERNAL_SECRET;
  const received = req.get("Authorization") || "";
  const a = Buffer.from(received),
    b = Buffer.from(`Bearer ${expected}`);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ error: "Internal authentication required" });
  next();
});
router.get("/:user/profile", async (req, res) => {
  try {
    const user = await require("../models/user").findById(req.params.user);
    if (!user) return res.sendStatus(404);
    return res.json({ type: user.type });
  } catch (error) {
    return res.status(500).json({ error: "Unable to read user profile" });
  }
});
router.post("/:user/:task/:action", async (req, res) => {
  if (
    !/^[a-f0-9]{24}$/i.test(req.params.user) ||
    !/^[a-f0-9-]{36}$/i.test(req.params.task)
  )
    return res.status(400).json({ error: "Invalid identifier" });
  try {
    const { user, task, action } = req.params;
    if (action === "reserve") await quota.reserve(user, task, req.body.profile);
    else if (["commit", "release"].includes(action))
      await quota.settle(user, task, action);
    else return res.sendStatus(404);
    res.json({ ok: true });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({
        error: e.status ? e.message : "Quota service failed",
        code: e.code,
      });
  }
});
module.exports = router;
