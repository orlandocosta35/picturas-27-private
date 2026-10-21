// Atomic updates on one user document: shared by images, resize and trim.
const User = require("../models/user");
const limit = Number(process.env.FREE_DAILY_OP || 5);
const reservations = { $ifNull: ["$videoReservations", []] };
const operations = { $ifNull: ["$operations", []] };
function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return new Date(`${value.year}-${value.month}-${value.day}T00:00:00Z`);
}
const held = (day) => ({
  $size: {
    $filter: {
      input: reservations,
      as: "r",
      cond: {
        $and: [
          { $eq: ["$$r.status", "reserved"] },
          { $eq: ["$$r.day", day] },
          "$$r.charged",
        ],
      },
    },
  },
});
const used = (day) => ({
  $sum: {
    $map: {
      input: {
        $filter: {
          input: operations,
          as: "o",
          cond: { $eq: ["$$o.day", day] },
        },
      },
      as: "o",
      in: "$$o.processed",
    },
  },
});
const allowed = (day, count) => ({
  $or: [
    { $eq: ["$type", "premium"] },
    {
      $and: [
        { $eq: ["$type", "free"] },
        { $lte: [{ $add: [used(day), held(day), count] }, limit] },
      ],
    },
    { $and: [{ $eq: ["$type", "anonymous"] }, { $eq: [count, 0] }] },
  ],
});
function changeOperations(day, delta) {
  return {
    $concatArrays: [
      {
        $filter: {
          input: operations,
          as: "o",
          cond: { $ne: ["$$o.day", day] },
        },
      },
      [{ day, processed: { $max: [0, { $add: [used(day), delta] }] } }],
    ],
  };
}
function error(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
async function reserveLegacy(userId, count) {
  if (!Number.isInteger(count) || count < 0)
    throw error("INVALID_COUNT", "Invalid operations number", 400);
  const day = today();
  const user = await User.findOneAndUpdate(
    { _id: userId, $expr: allowed(day, count) },
    [{ $set: { operations: changeOperations(day, count) } }],
    { new: true },
  );
  if (!user)
    throw error("QUOTA_EXCEEDED", "No more daily_operations available", 701);
}
async function refundLegacy(userId, count) {
  if (!Number.isInteger(count) || count <= 0)
    throw error("INVALID_COUNT", "Invalid operations number", 400);
  await User.updateOne({ _id: userId, type: { $ne: "premium" } }, [
    { $set: { operations: changeOperations(today(), -count) } },
  ]);
}
async function reserve(userId, taskId, profile) {
  const day = today();
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      type: profile,
      "videoReservations.id": { $ne: taskId },
      $expr: {
        $and: [
          allowed(day, 1),
          {
            $or: [
              { $eq: ["$type", "premium"] },
              {
                $eq: [
                  {
                    $size: {
                      $filter: {
                        input: reservations,
                        as: "r",
                        cond: { $eq: ["$$r.status", "reserved"] },
                      },
                    },
                  },
                  0,
                ],
              },
            ],
          },
        ],
      },
    },
    [
      {
        $set: {
          videoReservations: {
            $concatArrays: [
              reservations,
              [
                {
                  id: taskId,
                  day,
                  charged: profile === "free",
                  status: "reserved",
                },
              ],
            ],
          },
        },
      },
    ],
    { new: true },
  );
  if (user) return;
  const current = await User.findById(userId);
  const existing = current?.videoReservations?.find((r) => r.id === taskId);
  if (existing?.status === "reserved" || existing?.status === "committed")
    return;
  if (existing) throw error("TASK_RELEASED", "A tarefa já foi libertada.", 409);
  if (!current || !["free", "premium"].includes(current.type))
    throw error(
      "PROFILE_NOT_ALLOWED",
      "Este perfil não pode processar vídeo.",
      403,
    );
  if (current.type !== profile)
    throw error(
      "PROFILE_CHANGED",
      "O perfil foi alterado. Tente novamente.",
      409,
    );
  if (
    current.type === "free" &&
    current.videoReservations?.some((r) => r.status === "reserved")
  )
    throw error(
      "ACTIVE_TASK_LIMIT",
      "Já existe uma tarefa de vídeo ativa.",
      409,
    );
  throw error("QUOTA_EXCEEDED", "Atingiste o limite diário de operações.", 429);
}
async function settle(userId, taskId, action) {
  // CAS on reservation state; retry if a competing commit/release won.
  for (let attempt = 0; attempt < 4; attempt++) {
    const user = await User.findById(userId);
    if (!user) throw error("USER_NOT_FOUND", "Utilizador não encontrado.", 404);
    const r = user.videoReservations?.find((r) => r.id === taskId);
    if (!r) {
      if (action !== "release")
        throw error("RESERVATION_NOT_FOUND", "Reserva não encontrada.", 409);
      const result = await User.updateOne(
        { _id: userId, "videoReservations.id": { $ne: taskId } },
        {
          $push: {
            videoReservations: {
              id: taskId,
              day: today(),
              charged: false,
              status: "released",
            },
          },
        },
      );
      if (result.modifiedCount) return;
      continue;
    }
    const target = action === "commit" ? "committed" : "released";
    if (r.status === target) return;
    if (action === "commit" && r.status !== "reserved")
      throw error("TASK_RELEASED", "A tarefa já foi libertada.", 409);
    const delta = r.charged
      ? action === "commit"
        ? 1
        : r.status === "committed"
          ? -1
          : 0
      : 0;
    const result = await User.updateOne(
      {
        _id: userId,
        videoReservations: { $elemMatch: { id: taskId, status: r.status } },
      },
      [
        {
          $set: {
            operations: changeOperations(r.day, delta),
            videoReservations: {
              $map: {
                input: reservations,
                as: "r",
                in: {
                  $cond: [
                    { $eq: ["$$r.id", taskId] },
                    { $mergeObjects: ["$$r", { status: target }] },
                    "$$r",
                  ],
                },
              },
            },
          },
        },
      ],
    );
    if (result.modifiedCount) return;
  }
  throw error(
    "QUOTA_BUSY",
    "Não foi possível atualizar a reserva. Tente novamente.",
    503,
  );
}
module.exports = { today, reserveLegacy, refundLegacy, reserve, settle };
