const router = require("express").Router();
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const auth = require("../auth/auth");
const {
  context,
  internal,
  sourceName,
  failure,
  agent,
  projects,
} = require("./videoAccess");
const video = "http://video_processing:12000/video/audio";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20_000_000, files: 1, fields: 20 },
});
const fields = [
  "operation",
  "overlayMode",
  "volume",
  "originalVolume",
  "startSeconds",
  "fadeIn",
  "fadeOut",
  "shortPolicy",
  "confirmRemove",
  "confirmTrim",
  "confirmAmplification",
  "confirmZero",
];
function auxiliary(req, res, next) {
  upload.single("audio")(req, res, (error) => {
    if (error)
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "The audio file exceeds 20 MB."
            : "Invalid audio upload.",
        code: error.code,
      });
    next();
  });
}
async function submit(req, res, inspect) {
  let source;
  try {
    const headers = await context(req, "video-audio");
    const sourceId = req.body?.sourceResultId || req.query?.sourceResultId;
    if (
      sourceId &&
      (typeof sourceId !== "string" || !/^[a-f0-9-]{36}$/i.test(sourceId))
    )
      throw Object.assign(new Error("Invalid source result."), {
        status: 400,
      });
    const sourcePath = sourceId ? `results/${sourceId}/download` : "source";
    source = await axios.get(
      `${projects}/${req.params.user}/${req.params.project}/${sourcePath}`,
      {
        headers: internal(),
        httpsAgent: agent,
        responseType: "stream",
        timeout: 120000,
      },
    );
    const form = new FormData();
    form.append("video", source.data, {
      filename: sourceName(source.headers),
      contentType: source.headers["content-type"],
      ...(source.headers["content-length"]
        ? { knownLength: Number(source.headers["content-length"]) }
        : {}),
    });
    if (req.file)
      form.append("audio", req.file.buffer, {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
    if (sourceId) form.append("sourceResultId", sourceId);
    for (const key of fields)
      if (req.body?.[key] !== undefined)
        form.append(key, String(req.body[key]));
    const response = await axios.post(
      video + (inspect ? "/inspect" : ""),
      form,
      {
        headers: { ...form.getHeaders(), ...headers },
        timeout: 180000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );
    res.status(response.status).json(response.data);
  } catch (error) {
    await failure(res, error);
  } finally {
    source?.data.destroy();
  }
}
router.get(
  "/:user/:project/video/audio/metadata",
  auth.checkToken,
  (req, res) => submit(req, res, true),
);
router.post(
  "/:user/:project/video/audio/inspect",
  auth.checkToken,
  auxiliary,
  (req, res) => submit(req, res, true),
);
router.post(
  "/:user/:project/video/audio",
  auth.checkToken,
  auxiliary,
  (req, res) => submit(req, res, false),
);
router.get(
  "/:user/:project/video/audio/tasks",
  auth.checkToken,
  async (req, res) => {
    try {
      const response = await axios.get(`${video}/tasks`, {
        headers: await context(req, "video-audio"),
        timeout: 10000,
      });
      res.json(response.data);
    } catch (error) {
      await failure(res, error);
    }
  },
);
for (const method of ["get", "delete"])
  router[method](
    "/:user/:project/video/audio/tasks/:task",
    auth.checkToken,
    async (req, res) => {
      try {
        const response = await axios({
          method,
          url: `${video}/tasks/${encodeURIComponent(req.params.task)}`,
          headers: await context(req, "video-audio"),
          timeout: 45000,
        });
        res.status(response.status).json(response.data);
      } catch (error) {
        await failure(res, error);
      }
    },
  );
router.get(
  "/:user/:project/video/audio/tasks/:task/download",
  auth.checkToken,
  async (req, res) => {
    try {
      const response = await axios.get(
        `${video}/tasks/${encodeURIComponent(req.params.task)}/download`,
        {
          headers: await context(req, "video-audio"),
          responseType: "stream",
          timeout: 120000,
        },
      );
      for (const name of [
        "content-type",
        "content-length",
        "content-disposition",
      ])
        if (response.headers[name]) res.set(name, response.headers[name]);
      response.data.on("error", () => res.destroy());
      res.on("close", () => response.data.destroy());
      response.data.pipe(res);
    } catch (error) {
      await failure(res, error);
    }
  },
);
module.exports = router;
