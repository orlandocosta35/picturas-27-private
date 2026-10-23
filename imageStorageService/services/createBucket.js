const s3 = require("./s3Client");

async function createBucket(bucketName) {
  try {
    const buckets = await s3.listBuckets().promise();
    const exists = buckets.Buckets.some((bucket) => bucket.Name === bucketName);

    if (!exists) {
      await s3.createBucket({ Bucket: bucketName }).promise();
      console.log(`Bucket '${bucketName}' created successfully!`);
    }

    await createEmptyFolder(bucketName, "src/");
    await createEmptyFolder(bucketName, "preview/");
    await createEmptyFolder(bucketName, "out/");
  } catch (error) {
    console.error("Could not create bucket:", error.message);
    throw error;
  }
}

async function createEmptyFolder(bucketName, folderName) {
  const params = {
    Bucket: bucketName,
    Key: folderName,
    Body: "",
  };

  try {
    await s3.putObject(params).promise();
    console.log(`Directory '${folderName}' created in bucket '${bucketName}'.`);
  } catch (error) {
    console.error(`Could not create directory '${folderName}':`, error.message);
  }
}

module.exports = createBucket;
