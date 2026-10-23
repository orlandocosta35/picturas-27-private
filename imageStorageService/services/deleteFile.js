const s3 = require("./s3Client");

async function deleteFile(userId, projectId, stage, fileName) {
  const bucketName = `user-${userId}`;
  const key = `${projectId}/${stage}/${fileName}`;

  try {
    const params = {
      Bucket: bucketName,
      Key: key,
    };

    await s3.deleteObject(params).promise();
    console.log(`File '${key}' deleted from bucket '${bucketName}'.`);
    return { message: "File deleted successfully!", key };
  } catch (error) {
    console.error("Could not delete file:", error.message);
    throw error;
  }
}

module.exports = deleteFile;
