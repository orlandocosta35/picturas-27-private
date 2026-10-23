const assert = require("node:assert/strict");
const axios = require("axios");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("/source/users/models/user");
const Project = require("/source/projects/models/project");

let count = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  console.log("PASS", label);
  count++;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    name: "Frames test",
    type: "video",
    video: {
      originalName: "source.mp4",
      mimeType: "video/mp4",
      path: "/validation/fixtures/source.mp4",
    },
  });
  const token = jwt.sign({ id: String(owner) }, process.env.JWT_SECRET_KEY, {
    expiresIn: "1h",
  });
  const headers = { Authorization: "Bearer " + token };
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

  async function waitForCompletion(id) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await request("get", `/frames/tasks/${id}`);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      if (!["queued", "processing"].includes(response.data.status)) {
        assert.equal(
          response.data.status,
          "completed",
          JSON.stringify(response.data),
        );
        return response.data;
      }
      await pause(100);
    }
    throw new Error("Frame extraction task timeout");
  }

  let response = await request("post", "/frames", {
    startSeconds: 0,
    endSeconds: 1,
    mode: "fps",
    fps: 2,
    format: "png",
  });
  assert.equal(response.status, 202, JSON.stringify(response.data));
  const completed = await waitForCompletion(response.data.id);
  check(
    completed.result?.frameCount === 3 &&
      completed.result?.imageFormat === "png",
    "Frame extraction completes with the requested format",
  );

  response = await request("get", "/results");
  check(
    response.status === 200 &&
      response.data.some(
        (result) =>
          result.id === completed.id &&
          result.processor === "frames" &&
          result.format === "zip",
      ),
    "Completed frames are published in the project library",
  );
  response = await request("get", `/results/${completed.id}/download`, null, {
    responseType: "arraybuffer",
  });
  check(
    response.status === 200 &&
      response.headers["content-type"] === "application/zip" &&
      response.data.length > 100,
    "Published frames ZIP can be downloaded",
  );
  check(
    (await User.findById(owner)).operations[0].processed === 1,
    "Completed frame extraction consumes one shared operation",
  );

  response = await request("post", "/frames", {
    startSeconds: 0,
    endSeconds: 6,
    mode: "all",
    format: "jpeg",
  });
  assert.equal(response.status, 202, JSON.stringify(response.data));
  const cancelledId = response.data.id;
  response = await request("delete", `/frames/tasks/${cancelledId}`);
  check(
    response.status === 200 &&
      ["cancelled", "processing", "queued"].includes(response.data.status),
    "Active frame extraction accepts cancellation",
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await request("get", `/frames/tasks/${cancelledId}`);
    if (["cancelled", "failed", "completed"].includes(current.data.status)) {
      check(
        current.data.status === "cancelled",
        "Cancelled frame extraction reaches the cancelled state",
      );
      break;
    }
    await pause(100);
    if (attempt === 119) throw new Error("Cancellation task timeout");
  }
  const userAfterCancel = await User.findById(owner);
  check(
    !userAfterCancel.videoReservations.some(
      (reservation) =>
        reservation.id === cancelledId && reservation.status === "reserved",
    ),
    "Cancelled frame extraction releases its quota reservation",
  );
  response = await request("get", "/results");
  check(
    response.status === 200 &&
      !response.data.some((result) => result.id === cancelledId),
    "Cancelled frame extraction is not published",
  );

  console.log(`ALL ${count} frames integration checks passed`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.response?.data || error);
  process.exit(1);
});
