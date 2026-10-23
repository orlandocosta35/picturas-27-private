// UC-VID-004: extract a frame sequence from the stored project video.
// The caller supplies only extraction parameters; the gateway always reads the
// source from the projects service and forwards it to video_processing.
const router = require("express").Router();
const axios = require("axios");
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

const video = "http://video_processing:12000/video/frames";

async function withSource(req, res, fields) {
  let source;
  try {
    const headers = await context(req, "video-frames");
    source = await axios.get(
      `${projects}/${req.params.user}/${req.params.project}/source`,
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
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }

    const result = await axios.post(video, form, {
      headers: { ...form.getHeaders(), ...headers },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180000,
    });
    res.status(result.status).json(result.data);
  } catch (error) {
    await failure(res, error);
  } finally {
    source?.data.destroy();
  }
}

router.post(
  "/:user/:project/video/frames",
  auth.checkToken,
  (req, res) => {
    const {
      startSeconds,
      endSeconds,
      mode,
      fps,
      everyN,
      format,
      quality,
    } = req.body;
    return withSource(req, res, {
      startSeconds,
      endSeconds,
      mode,
      fps,
      everyN,
      format,
      quality,
    });
  },
);

router.get(
  "/:user/:project/video/frames/tasks",
  auth.checkToken,
  async (req, res) => {
    try {
      const headers = await context(req, "video-frames");
      const result = await axios.get(`${video}/tasks`, {
        headers,
        timeout: 10000,
      });
      res.json(result.data);
    } catch (error) {
      await failure(res, error);
    }
  },
);

for (const method of ["get", "delete"]) {
  router[method](
    "/:user/:project/video/frames/tasks/:task",
    auth.checkToken,
    async (req, res) => {
      try {
        const headers = await context(req, "video-frames");
        const result = await axios({
          method,
          url: `${video}/tasks/${encodeURIComponent(req.params.task)}`,
          headers,
          timeout: 30000,
        });
        res.status(result.status).json(result.data);
      } catch (error) {
        await failure(res, error);
      }
    },
  );
}

router.get(
  "/:user/:project/video/frames/tasks/:task/download",
  auth.checkToken,
  async (req, res) => {
    let result;
    try {
      const headers = await context(req, "video-frames");
      result = await axios.get(
        `${video}/tasks/${encodeURIComponent(req.params.task)}/download`,
        {
          headers,
          responseType: "stream",
          timeout: 120000,
        },
      );
      for (const name of [
        "content-type",
        "content-disposition",
        "content-length",
      ]) {
        if (result.headers[name]) res.set(name, result.headers[name]);
      }
      result.data.on("error", () => res.destroy());
      res.on("close", () => result.data.destroy());
      result.data.pipe(res);
    } catch (error) {
      await failure(res, error);
    }
  },
);

module.exports = router;
