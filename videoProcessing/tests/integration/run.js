const assert = require("node:assert/strict");
const axios = require("axios");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const FormData = require("form-data");
const User = require("/source/users/models/user");
const Project = require("/source/projects/models/project");
const quota = require("/source/users/services/operationQuota");
const agent = new https.Agent({ rejectUnauthorized: false });
let checks = 0;
function check(value, text) {
  assert.ok(value, text);
  checks++;
  console.log("PASS", text);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  await mongoose.connect("mongodb://uc2-mongo:27017/uc2");
  await User.deleteMany({});
  await Project.deleteMany({});
  const owner = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  await User.collection.insertMany([
    { _id: owner, type: "free", operations: [], videoReservations: [] },
    { _id: other, type: "free", operations: [], videoReservations: [] },
  ]);
  const project = await Project.create({
    user_id: owner,
    name: "Trim test",
    type: "video",
    video: {
      originalName: "sample.mp4",
      mimeType: "video/mp4",
      path: "/validation/fixtures/source.mp4",
    },
  });
  const token = (id) =>
    jwt.sign({ id: String(id) }, process.env.JWT_SECRET_KEY, {
      expiresIn: "1h",
    });
  const auth = { Authorization: `Bearer ${token(owner)}` };
  const base = `http://api_gateway:8000/projects/${owner}/${project._id}/video`;
  const request = (method, url, data, headers = auth, extra = {}) =>
    axios({
      method,
      url: base + url,
      data,
      headers,
      validateStatus: () => true,
      ...extra,
    });
  for (let i = 0; i < 40; i++) {
    try {
      await axios.get("http://video_processing:12000/video/trim/tasks", {
        validateStatus: () => true,
      });
      break;
    } catch {
      await pause(250);
    }
  }
  check(
    (
      await request(
        "post",
        "/trim",
        { startSeconds: 1, endSeconds: 3, mode: "precise" },
        {},
      )
    ).status === 401,
    "Reject missing authentication",
  );
  const direct = await axios.post(
    "http://video_processing:12000/video/trim",
    {},
    { validateStatus: () => true },
  );
  check(direct.status === 401, "Reject direct untrusted trim requests");
  let response = await request("post", "/trim", {
    startSeconds: 0,
    endSeconds: 6,
    mode: "fast",
  });
  check(
    response.status === 200 && response.data.status === "no_changes",
    "Full interval does not create a job",
  );
  check(
    (await User.findById(owner)).videoReservations.length === 0,
    "No quota reservation for no-op",
  );
  response = await request("post", "/trim", {
    startSeconds: 0.5,
    endSeconds: 3.5,
    mode: "fast",
  });
  check(
    response.status === 200 && response.data.status === "confirmation_required",
    "Fast mode requests confirmation",
  );
  check(
    (await User.findById(owner)).videoReservations.length === 0,
    "No quota reservation before confirmation",
  );
  response = await request("post", "/trim", {
    startSeconds: response.data.effectiveStartSeconds,
    endSeconds: response.data.effectiveEndSeconds,
    mode: "fast",
  });
  check(response.status === 202, "Confirmed fast trim accepted");
  const task = response.data.id;
  async function wait(id) {
    for (let i = 0; i < 100; i++) {
      const current = await request("get", `/trim/tasks/${id}`);
      assert.equal(current.status, 200, JSON.stringify(current.data));
      if (!["queued", "processing"].includes(current.data.status))
        return current.data;
      await pause(100);
    }
    throw new Error("Task timeout");
  }
  let current = await wait(task);
  check(
    current.status === "completed" && current.progress === 100,
    "Fast trim completes through all adapters",
  );
  let saved = await request("get", "/results");
  check(
    saved.status === 200 &&
      saved.data.length === 1 &&
      saved.data[0].id === task,
    "Trim result is listed in project library",
  );
  check(
    saved.data[0].name.startsWith("sample_corte_"),
    "Result name preserves original filename",
  );
  const download = await request(
    "get",
    `/results/${task}/download`,
    null,
    auth,
    { responseType: "arraybuffer" },
  );
  check(
    download.status === 200 && download.data.length > 100,
    "Saved result can be downloaded",
  );
  check(
    (await Project.findById(project._id)).video.path ===
      "/validation/fixtures/source.mp4",
    "Original reference preserved",
  );
  check(
    (await User.findById(owner)).operations[0].processed === 1,
    "Successful trim consumes exactly one shared operation",
  );
  const shared = await axios.get(`https://users:10001/${owner}/process/4`, {
    httpsAgent: agent,
    validateStatus: () => true,
  });
  check(
    shared.status === 200,
    "Existing image/resize endpoint shares the same quota",
  );
  response = await request("post", "/trim", {
    startSeconds: 1,
    endSeconds: 3,
    mode: "precise",
  });
  check(
    response.status === 429 && response.data.code === "QUOTA_EXCEEDED",
    "Trim refuses a quota exhausted by other operations",
  );
  const denied = await request("get", `/trim/tasks/${task}`, null, {
    Authorization: `Bearer ${token(other)}`,
  });
  check(
    denied.status === 401 || denied.status === 403,
    "Another user cannot inspect the task",
  );
  // Atomic mixed reservations: only five can win even when requests race.
  await User.updateOne(
    { _id: other },
    { $set: { operations: [], videoReservations: [] } },
  );
  const races = await Promise.allSettled(
    Array.from({ length: 12 }, () => quota.reserveLegacy(other, 1)),
  );
  check(
    races.filter((r) => r.status === "fulfilled").length === 5,
    "Atomic legacy reservations cannot overspend under concurrency",
  );
  // Release and commit are idempotent and stay assigned to the acceptance day.
  await User.updateOne(
    { _id: other },
    { $set: { operations: [], videoReservations: [] } },
  );
  check(
    quota
      .today(new Date("2026-06-01T23:30:00Z"))
      .toISOString()
      .startsWith("2026-06-02"),
    "Quota day follows Lisbon summer time",
  );
  check(
    quota
      .today(new Date("2026-12-01T23:30:00Z"))
      .toISOString()
      .startsWith("2026-12-01"),
    "Quota day follows Lisbon winter time",
  );
  const id = crypto.randomUUID();
  await quota.reserve(other, id, "free");
  await quota.reserve(other, id, "free");
  await quota.settle(other, id, "commit");
  await quota.settle(other, id, "commit");
  check(
    (await User.findById(other)).operations[0].processed === 1,
    "Repeated reserve/commit charges once",
  );
  await quota.settle(other, id, "release");
  await quota.settle(other, id, "release");
  check(
    (await User.findById(other)).operations[0].processed === 0,
    "Repeated release refunds once",
  );
  await assert.rejects(() => quota.reserve(other, id, "free"));
  check(true, "Released task cannot be reserved again");
  const one = crypto.randomUUID(),
    two = crypto.randomUUID();
  await quota.reserve(other, one, "free");
  const counter = await axios.get(`https://users:10001/${other}`, {
    httpsAgent: agent,
  });
  check(
    counter.data.remaining_operations === 4,
    "Remaining counter includes pending trim reservation",
  );
  await assert.rejects(
    () => quota.reserve(other, two, "free"),
    (e) => e.code === "ACTIVE_TASK_LIMIT",
  );
  await quota.settle(other, one, "release");
  check(true, "Free profile allows only one active trim");
  // A committed reservation remains charged to the acceptance day across midnight.
  const yesterday = new Date(quota.today().getTime() - 86400000);
  await User.updateOne(
    { _id: other },
    {
      $set: {
        operations: [],
        videoReservations: [
          {
            id: crypto.randomUUID(),
            day: yesterday,
            charged: true,
            status: "reserved",
          },
        ],
      },
    },
  );
  const midnightId = (await User.findById(other)).videoReservations[0].id;
  await quota.settle(other, midnightId, "commit");
  check(
    (await User.findById(other)).operations[0].day.getTime() ===
      yesterday.getTime(),
    "Commit charges acceptance day after midnight",
  );
  await quota.settle(other, midnightId, "release");
  check(
    (await User.findById(other)).operations[0].processed === 0,
    "Refund after midnight affects original day",
  );
  // Precise mode, with quota returned through the existing refund endpoint.
  await axios.post(
    `https://users:10001/${owner}/process/refund/4`,
    {},
    { httpsAgent: agent },
  );
  response = await request("post", "/trim", {
    startSeconds: 1.25,
    endSeconds: 3.25,
    mode: "precise",
  });
  check(response.status === 202, "Precise trim accepted");
  current = await wait(response.data.id);
  check(
    current.status === "completed",
    "Precise trim completes through all adapters",
  );
  const list = await request("get", "/trim/tasks");
  check(
    list.status === 200 && list.data.some((t) => t.id === task),
    "Tasks can be rediscovered after navigation",
  );
  // Existing UC1 routes and server processing still operate.
  const form = new FormData();
  form.append("video", fs.createReadStream("/validation/fixtures/source.mp4"), {
    filename: "source.mp4",
    contentType: "video/mp4",
  });
  for (const [k, v] of Object.entries({
    width: 128,
    height: 72,
    resizeMode: "contain",
    outputFormat: "mp4",
  }))
    form.append(k, String(v));
  response = await request("post", "/resize", form, {
    ...auth,
    ...form.getHeaders(),
  });
  check(response.status === 202, "UC1 resize route still accepts tasks");
  let resize;
  for (let i = 0; i < 100; i++) {
    resize = await request("get", `/tasks/${response.data.id}`);
    if (["completed", "failed"].includes(resize.data.status)) break;
    await pause(100);
  }
  check(resize.data.status === "completed", "UC1 resize still completes");
  fs.writeFileSync(
    "/validation/ui-context.json",
    JSON.stringify({
      userId: String(owner),
      projectId: String(project._id),
      token: token(owner),
    }),
  );
  console.log(`ALL ${checks} integration checks passed`);
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e.response?.data || e);
  process.exit(1);
});
