const axios = require("axios");
const https = require("https");
const jwt = require("jsonwebtoken");
const agent = new https.Agent({ rejectUnauthorized: false });
const projects = "https://projects:9001/internal/video";
const users = "https://users:10001";
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
async function context(req, audience = "video-trim") {
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
    { expiresIn: "5m", audience },
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
  res.status(error.response?.status || error.status || 502).json(
    data && typeof data === "object"
      ? data
      : {
          error: error.status
            ? error.message
            : "Serviço de vídeo indisponível.",
        },
  );
}

module.exports = { context, internal, sourceName, failure, agent, projects };
