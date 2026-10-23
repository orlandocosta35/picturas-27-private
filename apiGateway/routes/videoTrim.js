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
const video = "http://video_processing:12000/video/trim";
// Sends the stored original (never a caller upload) to a trim endpoint.
async function withSource(req, res, url, fields, timeout) {
  let source;
  try {
    const headers = await context(req);
    // Always use the stored original, never a replacement uploaded by the caller.
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
    for (const [key, value] of Object.entries(fields))
      if (value !== undefined) form.append(key, String(value));
    const result = await axios.post(url, form, {
      headers: { ...form.getHeaders(), ...headers },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout,
    });
    res.status(result.status).json(result.data);
  } catch (e) {
    await failure(res, e);
  } finally {
    source?.data.destroy();
  }
}
router.post("/:user/:project/video/trim", auth.checkToken, (req, res) => {
  const { startSeconds, endSeconds, mode } = req.body;
  return withSource(
    req,
    res,
    video,
    { startSeconds, endSeconds, mode },
    180000,
  );
});
// Fast-mode cut points, so the editor only offers those.
router.get(
  "/:user/:project/video/trim/keyframes",
  auth.checkToken,
  (req, res) => withSource(req, res, `${video}/keyframes`, {}, 120000),
);
router.get(
  "/:user/:project/video/trim/tasks",
  auth.checkToken,
  async (req, res) => {
    try {
      const headers = await context(req);
      const result = await axios.get(`${video}/tasks`, {
        headers,
        timeout: 10000,
      });
      res.json(result.data);
    } catch (e) {
      await failure(res, e);
    }
  },
);
for (const method of ["get", "delete"])
  router[method](
    "/:user/:project/video/trim/tasks/:task",
    auth.checkToken,
    async (req, res) => {
      try {
        const headers = await context(req);
        const result = await axios({
          method,
          url: `${video}/tasks/${encodeURIComponent(req.params.task)}`,
          headers,
          timeout: 30000,
        });
        res.status(result.status).json(result.data);
      } catch (e) {
        await failure(res, e);
      }
    },
  );
function streamRoute(route, url, trim) {
  router.get(route, auth.checkToken, async (req, res) => {
    try {
      const headers = await context(req);
      const result = await axios.get(url(req), {
        headers: trim ? headers : internal(),
        httpsAgent: agent,
        responseType: "stream",
        timeout: 120000,
      });
      for (const name of [
        "content-type",
        "content-disposition",
        "content-length",
      ])
        if (result.headers[name]) res.set(name, result.headers[name]);
      result.data.on("error", () => res.destroy());
      res.on("close", () => result.data.destroy());
      result.data.pipe(res);
    } catch (e) {
      await failure(res, e);
    }
  });
}
streamRoute(
  "/:user/:project/video/trim/tasks/:task/download",
  (req) => `${video}/tasks/${encodeURIComponent(req.params.task)}/download`,
  true,
);
streamRoute(
  "/:user/:project/video/results/:task/download",
  (req) =>
    `${projects}/${req.params.user}/${req.params.project}/results/${encodeURIComponent(req.params.task)}/download`,
  false,
);
router.get(
  "/:user/:project/video/results",
  auth.checkToken,
  async (req, res) => {
    try {
      await context(req);
      const result = await axios.get(
        `${projects}/${req.params.user}/${req.params.project}/results`,
        { headers: internal(), httpsAgent: agent, timeout: 10000 },
      );
      res.json(result.data);
    } catch (e) {
      await failure(res, e);
    }
  },
);
module.exports = router;
