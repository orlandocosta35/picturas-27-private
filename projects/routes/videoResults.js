const router = require("express").Router();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Project = require("../models/project");
const mime = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
// Each video operation keeps its tasks in its own folder of the video_data volume.
const resultRoots = {
  trim: process.env.VIDEO_RESULTS_ROOT || "/video-tasks/tasks/trim",
  concat: process.env.VIDEO_CONCAT_RESULTS_ROOT || "/video-tasks/tasks/concat",
};
router.use((req, res, next) => {
  const secret = process.env.VIDEO_INTERNAL_SECRET;
  const a = Buffer.from(req.get("Authorization") || ""),
    b = Buffer.from(`Bearer ${secret}`);
  if (!secret || a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.sendStatus(401);
  next();
});
router.use("/:user/:project", async (req, res, next) => {
  if (
    ![req.params.user, req.params.project].every((v) =>
      /^[a-f0-9]{24}$/i.test(v),
    )
  )
    return res.sendStatus(400);
  try {
    const project = await Project.findOne({
      _id: req.params.project,
      user_id: req.params.user,
      type: "video",
    });
    if (!project?.video)
      return res.status(404).json({ error: "Video project not found" });
    req.videoProject = project;
    next();
  } catch (e) {
    next(e);
  }
});
router.get("/:user/:project/source", (req, res) => {
  res.type(req.videoProject.video.mimeType);
  res.download(
    path.resolve(req.videoProject.video.path),
    req.videoProject.video.originalName,
  );
});
router.get("/:user/:project/results", (req, res) => {
  res.json(
    (req.videoProject.videoResults || [])
      .filter((r) => r.status === "published")
      .map((r) => ({
        id: r.id,
        name: r.name,
        format: r.format,
        createdAt: r.createdAt,
        ...r.metadata,
      })),
  );
});
router.get("/:user/:project/results/:task/download", (req, res) => {
  const item = req.videoProject.videoResults.find(
    (r) => r.id === req.params.task && r.status === "published",
  );
  if (!item) return res.sendStatus(404);
  res.type(mime[item.format]);
  res.download(path.resolve(item.path), item.name);
});
router.post("/:user/:project/results/:task", async (req, res, next) => {
  const { task, user, project } = req.params;
  const { format, name, metadata, kind = "trim" } = req.body;
  if (
    !/^[a-f0-9-]{36}$/i.test(task) ||
    !mime[format] ||
    typeof name !== "string" ||
    !Object.hasOwn(resultRoots, kind)
  )
    return res.sendStatus(400);
  const existing = req.videoProject.videoResults.find((r) => r.id === task);
  if (existing)
    return existing.status === "published"
      ? res.json({ ok: true })
      : res.sendStatus(409);
  const directory = path.resolve(
    process.env.VIDEO_LIBRARY_ROOT || path.join(__dirname, "../images"),
    `users/${user}/projects/${project}/video/results`,
  );
  const destination = path.join(directory, `${task}.${format}`);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    const source = path.join(resultRoots[kind], task, `result.${format}`);
    await fs.promises.copyFile(source, temporary);
    await fs.promises.rename(temporary, destination);
    const updated = await Project.updateOne(
      { _id: project, user_id: user, "videoResults.id": { $ne: task } },
      {
        $push: {
          videoResults: {
            id: task,
            status: "published",
            name: path.basename(name),
            format,
            path: destination,
            metadata,
            createdAt: new Date(),
          },
        },
        $inc: { version: 1 },
      },
    );
    if (!updated.modifiedCount) {
      const current = await Project.findById(project);
      if (
        !current?.videoResults.some(
          (r) => r.id === task && r.status === "published",
        )
      ) {
        await fs.promises.unlink(destination).catch(() => {});
        return res.sendStatus(409);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
});
router.delete("/:user/:project/results/:task", async (req, res, next) => {
  const { user, project, task } = req.params;
  if (!/^[a-f0-9-]{36}$/i.test(task)) return res.sendStatus(400);
  try {
    // Tombstone also blocks a delayed publish after a request timeout.
    await Project.updateOne(
      { _id: project, user_id: user, "videoResults.id": { $ne: task } },
      { $push: { videoResults: { id: task, status: "released" } } },
    );
    await Project.updateOne(
      { _id: project, user_id: user, "videoResults.id": task },
      { $set: { "videoResults.$.status": "released" } },
    );
    const directory = path.resolve(
      process.env.VIDEO_LIBRARY_ROOT || path.join(__dirname, "../images"),
      `users/${user}/projects/${project}/video/results`,
    );
    for (const ext of Object.keys(mime))
      await fs.promises
        .unlink(path.join(directory, `${task}.${ext}`))
        .catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
module.exports = router;
