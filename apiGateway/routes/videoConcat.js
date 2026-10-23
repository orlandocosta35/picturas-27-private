// UC-VID-005: concatenation. Same trust boundary as videoTrim.js: the caller only
// sends project IDs; the gateway fetches each stored original (which also checks
// that the project belongs to the caller) and signs a short-lived "video-concat" JWT.
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
const video = "http://video_processing:12000/video/concat";
const AUDIENCE = "video-concat";
// Upper bound for any profile (RN3); the per-profile limit is enforced by the service.
const MAX_INPUTS = 20;

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Library: the user's uploaded videos (one original per video project), with the
// metadata read by the video service (REQ-VID-CON-007).
router.get("/:user/:project/video/concat/library", auth.checkToken, async (req, res) => {
  try {
    const headers = await context(req, AUDIENCE);
    const result = await axios.get(`${video}/library`, { headers, timeout: 120000 });
    res.json(result.data);
  } catch (e) {
    await failure(res, e);
  }
});

// Body: { videos: [projectId, ...] } in the desired order (RN2). The result is
// published in :project, the project from which the operation was started.
router.post("/:user/:project/video/concat", auth.checkToken, async (req, res) => {
  const sources = [];
  try {
    const headers = await context(req, AUDIENCE);
    const ids = req.body?.videos;
    if (!Array.isArray(ids) || ids.length < 2)
      throw invalid("Selecione pelo menos dois vídeos para concatenar.");
    if (ids.length > MAX_INPUTS)
      throw invalid(`É possível concatenar no máximo ${MAX_INPUTS} vídeos.`);
    if (!ids.every((id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id)))
      throw invalid("Identificador de vídeo inválido.");

    // The destination must be one of the caller's video projects; checking now
    // avoids processing a result that could not be published afterwards.
    await axios.get(`${projects}/${req.params.user}/${req.params.project}/results`, {
      headers: internal(),
      httpsAgent: agent,
      timeout: 10000,
    });

    const form = new FormData();
    for (const [index, id] of ids.entries()) {
      let source;
      try {
        source = await axios.get(`${projects}/${req.params.user}/${id}/source`, {
          headers: internal(),
          httpsAgent: agent,
          responseType: "stream",
          timeout: 120000,
        });
      } catch (e) {
        if (e.response?.status === 404)
          throw invalid(`O vídeo ${index + 1} não foi encontrado na sua biblioteca.`, 404);
        throw e;
      }
      sources.push(source);
      // Field order is the concatenation order.
      form.append("videos", source.data, {
        filename: sourceName(source.headers),
        contentType: source.headers["content-type"],
        ...(source.headers["content-length"]
          ? { knownLength: Number(source.headers["content-length"]) }
          : {}),
      });
    }
    const result = await axios.post(video, form, {
      headers: { ...form.getHeaders(), ...headers },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
    });
    res.status(result.status).json(result.data);
  } catch (e) {
    await failure(res, e);
  } finally {
    for (const source of sources) source.data.destroy();
  }
});

router.get("/:user/:project/video/concat/tasks", auth.checkToken, async (req, res) => {
  try {
    const headers = await context(req, AUDIENCE);
    const result = await axios.get(`${video}/tasks`, { headers, timeout: 10000 });
    res.json(result.data);
  } catch (e) {
    await failure(res, e);
  }
});

for (const method of ["get", "delete"])
  router[method](
    "/:user/:project/video/concat/tasks/:task",
    auth.checkToken,
    async (req, res) => {
      try {
        const headers = await context(req, AUDIENCE);
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

router.get(
  "/:user/:project/video/concat/tasks/:task/download",
  auth.checkToken,
  async (req, res) => {
    try {
      const headers = await context(req, AUDIENCE);
      const result = await axios.get(
        `${video}/tasks/${encodeURIComponent(req.params.task)}/download`,
        { headers, responseType: "stream", timeout: 120000 },
      );
      for (const name of ["content-type", "content-disposition", "content-length"])
        if (result.headers[name]) res.set(name, result.headers[name]);
      result.data.on("error", () => res.destroy());
      res.on("close", () => result.data.destroy());
      result.data.pipe(res);
    } catch (e) {
      await failure(res, e);
    }
  },
);

module.exports = router;
