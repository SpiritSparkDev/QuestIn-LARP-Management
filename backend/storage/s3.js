import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

export function s3Storage(config) {
  const client = new S3Client({
    region: config.region || 'us-east-1',
    endpoint: config.endpoint || undefined,
    forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  return {
    async upload(id, buffer) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: id, Body: buffer }));
    },
    async download(id) {
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: id }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
    async remove(id) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: id }));
    },
    async testConnection() {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    },
  };
}
