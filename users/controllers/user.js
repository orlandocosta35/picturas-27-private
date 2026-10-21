const bcrypt = require("bcrypt");
const User = require("../models/user");
const { hashEmail } = require("../utils/fieldCrypto");

async function encrypt_password(user) {
  const salt = await bcrypt.genSalt();
  user.password_hash = await bcrypt.hash(user.password, salt);

  delete user.password;

  return user;
}

module.exports.getAll = async () => {
  const users = await User.find().sort({ _id: 1 }).exec();

  return users.map((u) => u.toJSON());
};


module.exports.getOne = async (user_id) => {
  const user = await User.findOne({ _id: user_id }).exec();
  if (!user) return null;
  const day = require("../services/operationQuota").today();
  return { ...user.toJSON(), reserved_video_operations: (user.videoReservations || [])
    .filter(r => r.status === "reserved" && r.charged && r.day.getTime() === day.getTime()).length };
};

module.exports.getOneEmail = async (email) => {
  const emailHash = hashEmail(email);
  return await User.findOne({ email_hash: emailHash }).exec();
};


module.exports.create = async (user) => {
  try {
    const encrypt_user = await encrypt_password(user);
    const created = await User.create(encrypt_user);
    // devolve já o objeto JSON com email desencriptado e campos sensíveis removidos
    return created.toJSON();
  } catch (error) {
    if (error.code === 11000 && error.keyPattern && error.keyPattern.email_hash) {
      throw Error("The given email is already in use.");
    }
    throw error;
  }
};

module.exports.updatePassword = async (user_id, user) => {
  const encrypt_user = await encrypt_password(user);

  delete encrypt_user.operations;
  delete encrypt_user.videoReservations;
  return User.updateOne({ _id: user_id }, encrypt_user);
};

module.exports.update = async (user_id, user) => {
  const { operations, videoReservations, ...profile } = user;
  return User.updateOne({ _id: user_id }, profile);
};

module.exports.delete = (user_id) => {
  return User.deleteOne({ _id: user_id });
};
