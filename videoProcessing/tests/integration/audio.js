// Run after run.js; seeds a separate owner in the isolated uc2 database.
const assert = require("node:assert/strict");
const axios = require("axios");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const https = require("https");
const FormData = require("form-data");
const User = require("/source/users/models/user");
const Project = require("/source/projects/models/project");
const agent = new https.Agent({ rejectUnauthorized: false });
let count = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  console.log("PASS", label);
  count++;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  await mongoose.connect("mongodb://uc2-mongo:27017/uc2");
  const owner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: owner,
    type: "free",
    operations: [],
    videoReservations: [],
  });
  const project = await Project.create({
    user_id: owner,
    name: "Audio test",
    type: "video",
    video: {
      originalName: "sample.mp4",
      mimeType: "video/mp4",
      path: "/validation/fixtures/source.mp4",
    },
  });
  const token = jwt.sign({ id: String(owner) }, process.env.JWT_SECRET_KEY, {
    expiresIn: "1h",
  });
  const headers = { Authorization: `Bearer ${token}` };
  const base = `http://api_gateway:8000/projects/${owner}/${project._id}/video`;
  const request = (method, path, data, extra = {}) =>
    axios({
      method,
      url: base + path,
      data,
      headers,
      validateStatus: () => true,
      ...extra,
    });
  async function submit(params, file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    if (file)
      form.append("audio", fs.createReadStream(file), {
        filename: "music.wav",
        contentType: "audio/wav",
      });
    return request("post", "/audio", form, {
      headers: { ...headers, ...form.getHeaders() },
    });
  }
  async function complete(response) {
    assert.equal(response.status, 202, JSON.stringify(response.data));
    for (let i = 0; i < 100; i++) {
      const current = await request("get", `/audio/tasks/${response.data.id}`);
      assert.equal(current.status, 200, JSON.stringify(current.data));
      if (!["queued", "processing"].includes(current.data.status)) {
        assert.equal(
          current.data.status,
          "completed",
          JSON.stringify(current.data),
        );
        return current.data;
      }
      await pause(100);
    }
    throw new Error("Audio task timeout");
  }
  let response = await request("get", "/audio/metadata");
  check(
    response.status === 200 && response.data.video.has_audio,
    "Audio metadata is inspected from stored source",
  );
  check(
    (await User.findById(owner)).videoReservations.length === 0,
    "Metadata inspection does not reserve quota",
  );
  let task = await complete(await submit({ operation: "volume", volume: 50 }));
  check(
    task.progress === 100,
    "Volume operation completes through gateway and adapters",
  );
  let results = await request("get", "/results");
  check(
    results.data.some(
      (r) =>
        r.id === task.id && r.processor === "audio" && r.operation === "volume",
    ),
    "Audio result is published with operation metadata",
  );
  response = await request("get", `/results/${task.id}/download`, null, {
    responseType: "arraybuffer",
  });
  check(
    response.status === 200 && response.data.length > 100,
    "Published audio result can be downloaded",
  );
  check(
    (await User.findById(owner)).operations[0].processed === 1,
    "Volume consumes one shared operation",
  );
  response = await submit({ operation: "remove" });
  check(
    response.status === 200 && response.data.status === "confirmation_required",
    "Remove asks for confirmation without creating a task",
  );
  check(
    (await User.findById(owner)).operations[0].processed === 1,
    "Confirmation does not consume an operation",
  );
  const removed = await complete(
    await submit({ operation: "remove", confirmRemove: true }),
  );
  check(
    removed.result.hasAudio === false,
    "Confirmed removal produces a silent video",
  );
  response = await request(
    "get",
    `/audio/metadata?sourceResultId=${removed.id}`,
  );
  check(
    response.status === 200 && !response.data.video.has_audio,
    "A saved result can be selected as the next input",
  );
  response = await submit({
    operation: "volume",
    sourceResultId: removed.id,
    volume: 50,
  });
  check(
    response.status === 400 && response.data.code === "NO_AUDIO_TRACK",
    "Volume is rejected on a selected silent result",
  );
  response = await submit(
    { operation: "overlay", overlayMode: "replace" },
    "/validation/fixtures/music.wav",
  );
  check(
    response.status === 200 && response.data.status === "choice_required",
    "Short audio requires an explicit repeat/silence choice",
  );
  task = await complete(
    await submit(
      {
        operation: "overlay",
        overlayMode: "replace",
        shortPolicy: "repeat",
        sourceResultId: removed.id,
      },
      "/validation/fixtures/music.wav",
    ),
  );
  check(
    task.result.hasAudio === true,
    "Replacement adds audio to a saved silent result",
  );
  check(
    (await User.findById(owner)).operations[0].processed === 3,
    "Three successful audio operations charge three shared operations",
  );
  check(
    (await Project.findById(project._id)).video.path ===
      "/validation/fixtures/source.mp4",
    "Audio operations preserve original project video",
  );
  const listed = await request("get", "/audio/tasks");
  check(
    listed.status === 200 && listed.data.length === 3,
    "Audio tasks can be recovered after navigation",
  );
  const denied = await axios.get(base + "/audio/tasks", {
    validateStatus: () => true,
  });
  check(denied.status === 401, "Audio routes reject unauthenticated callers");
  const wrongAudience = jwt.sign(
    {
      user_id: String(owner),
      project_id: String(project._id),
      profile: "free",
    },
    process.env.VIDEO_INTERNAL_SECRET,
    { audience: "video-trim", expiresIn: "1m" },
  );
  const direct = await axios.get(
    "http://video_processing:12000/video/audio/tasks",
    {
      headers: { Authorization: `Bearer ${wrongAudience}` },
      validateStatus: () => true,
    },
  );
  check(
    direct.status === 401,
    "Trim credentials cannot be reused for audio requests",
  );
  await axios.get(`https://users:10001/${owner}/process/2`, {
    httpsAgent: agent,
  });
  response = await submit({ operation: "volume", volume: 50 });
  check(
    response.status === 429,
    "Audio shares the quota already used by other video/image operations",
  );
  // Prepare a fresh premium account for optional browser tests.
  const browserOwner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: browserOwner,
    type: "premium",
    operations: [],
    videoReservations: [],
  });
  const browserProject = await Project.create({
    user_id: browserOwner,
    name: "Audio UI",
    type: "video",
    video: {
      originalName: "sample.mp4",
      mimeType: "video/mp4",
      path: "/validation/fixtures/source.mp4",
    },
  });
  fs.writeFileSync(
    "/validation/audio-ui-context.json",
    JSON.stringify({
      userId: String(browserOwner),
      projectId: String(browserProject._id),
      token: jwt.sign(
        { id: String(browserOwner) },
        process.env.JWT_SECRET_KEY,
        { expiresIn: "1h" },
      ),
    }),
  );
  console.log(`ALL ${count} audio integration checks passed`);
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e.response?.data || e);
  process.exit(1);
});
