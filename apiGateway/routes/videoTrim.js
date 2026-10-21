const router = require("express").Router();
const axios = require("axios");
const https = require("https");
const jwt = require("jsonwebtoken");
const FormData = require("form-data");
const auth = require("../auth/auth");
const agent = new https.Agent({ rejectUnauthorized: false });
const projects = "https://projects:9001/internal/video";
const users = "https://users:10001";
const video = "http://video_processing:12000/video/trim";
function sourceName(headers) {
  const disposition = headers["content-disposition"] || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* Use plain filename. */
    }
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || "video-original";
}
function internal() {
  const secret = process.env.VIDEO_INTERNAL_SECRET;
  if (!secret) throw new Error("VIDEO_INTERNAL_SECRET is required");
  return { Authorization: `Bearer ${secret}` };
}
async function context(req) {
  if (String(req.authUserId) !== req.params.user) {
    throw Object.assign(new Error("Not allowed"), { status: 403 });
  }
  if (
    ![req.params.user, req.params.project].every((v) =>
      /^[a-f0-9]{24}$/i.test(v),
    )
  )
    throw Object.assign(new Error("Invalid identifier"), { status: 400 });
  const result = await axios.get(`${users}/${req.authUserId}/type/`, {
    httpsAgent: agent,
    timeout: 10000,
  });
  const profile = result.data.type;
  if (!["free", "premium"].includes(profile))
    throw Object.assign(
      new Error("O perfil Anónimo não pode processar vídeo."),
      { status: 403 },
    );
  const token = jwt.sign(
    { user_id: req.authUserId, project_id: req.params.project, profile },
    process.env.VIDEO_INTERNAL_SECRET,
    { expiresIn: "5m", audience: "video-trim" },
  );
  return { Authorization: `Bearer ${token}` };
}
async function failure(res, error) {
  let data = error.response?.data;
  if (data && typeof data.on === "function") {
    const chunks = [];
    for await (const chunk of data) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 65536) break;
    }
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      data = null;
    }
  }
  res
    .status(error.response?.status || error.status || 502)
    .json(
      data && typeof data === "object"
        ? data
        : {
            error: error.status
              ? error.message
              : "Serviço de vídeo indisponível.",
          },
    );
}
router.post("/:user/:project/video/trim", auth.checkToken, async (req, res) => {
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
    for (const key of ["startSeconds", "endSeconds", "mode"])
      if (req.body[key] !== undefined) form.append(key, String(req.body[key]));
    const result = await axios.post(video, form, {
      headers: { ...form.getHeaders(), ...headers },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180000,
    });
    res.status(result.status).json(result.data);
  } catch (e) {
    await failure(res, e);
  } finally {
    source?.data.destroy();
  }
});
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
