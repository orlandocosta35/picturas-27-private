const fs = require("fs");
const https = require("https");
const express = require("express");
const root = "/source";
async function main() {
  const role = process.env.TEST_ROLE;
  const tls = {
    key: fs.readFileSync(root + "/users/certs/selfsigned.key"),
    cert: fs.readFileSync(root + "/users/certs/selfsigned.crt"),
  };
  const app = express();
  app.use(express.json());
  if (role !== "gateway")
    await require("mongoose").connect("mongodb://uc2-mongo:27017/uc2");
  if (role === "users") {
    app.use(
      "/internal/video-quota",
      require(root + "/users/routes/videoQuota"),
    );
    app.use("/", require(root + "/users/routes/users"));
  } else if (role === "projects")
    app.use("/internal/video", require(root + "/projects/routes/videoResults"));
  else {
    app.use("/projects", require(root + "/apiGateway/routes/projects"));
    app.use("/users", require(root + "/apiGateway/routes/users"));
  }
  app.use((e, req, res, next) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });
  if (role === "gateway") app.listen(8000, "0.0.0.0");
  else
    https
      .createServer(tls, app)
      .listen(role === "users" ? 10001 : 9001, "0.0.0.0");
  console.log(role + " test service ready");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
