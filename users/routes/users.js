var express = require("express");
var router = express.Router();

const axios = require("axios");
const fs = require("fs");
const https = require("https");

const auth = require("../auth/auth");
const User = require("../controllers/user");   

// lê as chaves/certificados locais (estes ficheiros EXISTEM no api-gateway-ms)
const key = fs.readFileSync(__dirname + "/../certs/selfsigned.key");
const cert = fs.readFileSync(__dirname + "/../certs/selfsigned.crt");

// agente HTTPS com cert + key
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  cert,
  key,
});

// hostname interno do microserviço de users
const usersURL = "https://users:10001/";

// URL interna do microserviço de projects
const projects_ms = "https://projects:10002/projects/";

const max_free_daily_op = process.env.FREE_DAILY_OP || 5;

const quota = require("../services/operationQuota");
function get_cur_date() {
  const day = quota.today();
  return { year: day.getUTCFullYear(), month: day.getUTCMonth(), day: day.getUTCDate() };
}

function removeSensitiveInfo(user) {
  return user.toJSON ? user.toJSON() : user;
}

function getRemainingOperations(user) {
  if (user.type === "premium") return null; 

  const { year, month, day } = get_cur_date();
  const today = new Date(Date.UTC(year, month, day));

  const opToday = user.operations.find(
    (o) => o.day.getTime() === today.getTime()
  );

  const reserved = user.reserved_video_operations ?? (user.videoReservations || [])
    .filter(r => r.status === "reserved" && r.charged && new Date(r.day).getTime() === today.getTime()).length;
  const used = (opToday ? opToday.processed : 0) + reserved;

  if (user.type === "free")
    return Math.max(0, max_free_daily_op - used);

  // anonymous não pode usar advanced_tools -> 0 operações “pagas”
  if (user.type === "anonymous") return 0;

  return 0;
}


// Get list of all users
router.get("/", function (req, res, next) {
  User.getAll()
    .then((users) => res.status(200).jsonp(users))
    .catch((_) => res.status(700).jsonp(`Error acquiring all users`));
});

router.get("/validate/:user", function (req, res, next) {
  if (!req.headers.authorization) {
    return res.status(400).jsonp("Missing or invalid Authorization header.");
  }
  User.getOne(req.params.user)
    .then((user) => {
      const token = req.headers.authorization.split(" ")[1];
      try {
        const isValid = auth.validate_jwt(user, token);
        if (isValid) {
          const userResponse = removeSensitiveInfo(user);
          const remaining_operations = getRemainingOperations(user);

          res.status(200).json({
            user: { ...userResponse, remaining_operations },
            token: token,
          });
        } else res.status(401).jsonp("Invalid token.");
      } catch (err) {
        console.error(err);
        res.status(500).jsonp("Error validating token.");
      }
    })
    .catch((_) => res.status(701).jsonp(`Error acquiring user's information.`));
});

// Get specific user
router.get("/:user", function (req, res, next) {
  User.getOne(req.params.user)
    .then((user) => {
      const userResponse = removeSensitiveInfo(user);
      const remaining_operations = getRemainingOperations(user);
      res.status(200).jsonp({ ...userResponse, remaining_operations });
    })
    .catch((_) => res.status(701).jsonp(`Error acquiring user's information.`));
});

// Check user type
router.get("/:user/type/", function (req, res, next) {
  User.getOne(req.params.user)
    .then((user) => {
      res.status(200).send({ type: user.type });
    })
    .catch((_) => res.status(701).jsonp(`Error acquiring user's information.`));
});

// Test if we can process a project based on the number of advanced tools
router.get("/:user/process/:advanced_tools", async function (req, res, next) {
  try {
    await quota.reserveLegacy(req.params.user, Number(req.params.advanced_tools));
    return res.status(200).jsonp(true);
  } catch (error) { return res.status(error.status || 500).jsonp(error.message); }
});


// Create a new user
router.post("/", function (req, res, next) {
  const user = {
    name: req.body.name || undefined,
    email: req.body.email || undefined,
    type: req.body.type || "free",
    operations: [],
  };

  // Handle anonymous user properly
  if (req.body.type === "anonymous") {
    user.email = undefined;
    user.password = "";
  } else {
    user.password = req.body.password;
  }

  console.log("---- USERS-MS: REGISTER REQUEST ----");
  console.log("BODY:", req.body);
  console.log("USER OBJECT BEFORE SAVE:", user);
  console.log("User object to persist:", user);

  User.create(user)
    .then((createdUser) => {
      const userResponse = removeSensitiveInfo(createdUser);
      const remaining_operations = getRemainingOperations(createdUser);

      res.status(201).jsonp({
        user: { ...userResponse, remaining_operations },
        jwt: auth.get_jwt(createdUser),
      });
    })
    .catch((err) => {
      console.error("USERS-MS ERROR CREATING USER:");
      console.error(err);              // stack completo
      console.error(err.message);
      console.error(err?.errors);      // mongoose validation errors
      console.error(err?.response?.data);

      res.status(702).jsonp("Error creating a new user.");
    });
});

// Login user
router.post("/:email/login", function (req, res, next) {
  User.getOneEmail(req.params.email)
    .then(async (user) => {
      const correct_pass = await auth.authenticate(req.body.password, user);
      if (correct_pass) {
        const userResponse = removeSensitiveInfo(user);
        const remaining_operations = getRemainingOperations(user);

        res.status(200).jsonp({
          user: { ...userResponse, remaining_operations },
          jwt: auth.get_jwt(user),
        });
      } else res.status(401).jsonp("The provided credentials are incorrect");
    })
    .catch((_) => res.status(701).jsonp(`Error acquiring user's information.`));
});

// Update user info
router.put("/:user", function (req, res, next) {
  User.getOne(req.params.user)
    .then((user) => {
      user.name = req.body.name || user.name;
      user.email = req.body.email || user.email;
      user.type = req.body.type || user.type;

      if (req.body.password != null) {
        user.password = req.body.password || user.password;

        User.updatePassword(req.params.user, user)
          .then((_) => res.sendStatus(204))
          .catch((_) =>
            res.status(703).jsonp(`Error updating user's information`),
          );
      } else {
        User.update(req.params.user, user)
          .then((_) => res.sendStatus(204))
          .catch((_) =>
            res.status(704).jsonp(`Error updating user's information`),
          );
      }
    })
    .catch((_) => res.status(701).jsonp(`Error acquiring user's information.`));
});

// Update number of advanced tools used
router.put("/:user/process/:advanced_tools", async function (req, res) {
  try {
    await quota.reserveLegacy(req.params.user, Number(req.params.advanced_tools));
    res.sendStatus(204);
  } catch (error) { res.status(error.status || 500).jsonp(error.message); }
});

router.post("/:user/process/refund/:advanced_tools", async function (req, res) {
  try {
    await quota.refundLegacy(req.params.user, Number(req.params.advanced_tools));
    res.status(200).jsonp(true);
  } catch (error) { res.status(error.status || 500).jsonp(error.message); }
});

// Delete a user + all related data (projects, daily ops, etc.)
router.delete("/:user", async function (req, res, next) {
  const userId = req.params.user;

  try {
    // Garantir que o user do token é o mesmo
    // Se o API Gateway já valida isto, podes confiar nele.
    if (!req.headers.authorization) {
      return res.status(401).jsonp("Missing Authorization header");
    }

    const authHeader = req.headers.authorization;

    // 1) Apagar projetos do utilizador no projects-ms
    try {
      await axios.delete(projects_ms + userId, {
        httpsAgent,
        headers: {
          Authorization: authHeader,
        },
      });
    } catch (err) {
      console.error(
        "Error deleting user's projects:",
        err.response?.status,
        err.response?.data
      );
      // Se for para falhar logo: return res.status(502).jsonp("Error deleting user's projects");
      // Aqui estou a continuar mesmo que dê erro, para não bloquear o delete de conta.
    }

    // 2) Apagar o próprio utilizador
    await User.delete(userId);

    // 3) (Opcional) Apagar daily_operations associadas ao user
    // if (dailyoperationsModel) {
    //   await dailyoperationsModel.dailyOperation_deleteByUserId(userId);
    // }

    return res.sendStatus(204);
  } catch (err) {
    console.error("Error deleting user and related data:", err);
    return res
      .status(705)
      .jsonp(`Error deleting user's information and related data`);
  }
});


module.exports = router;
