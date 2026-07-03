import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY || 'streamtube',
  secretKey: process.env.S3_SECRET_KEY || 'streamtube',
  // Part size for S3 multipart uploads. Must keep a 10GB file under the
  // 10,000-part hard limit: 10GB / 100MB ≈ 103 parts. Min part size is 5MB
  // (enforced by S3/MinIO for every part except the last).
  partSize: parseInt(process.env.S3_PART_SIZE || '104857600', 10),
}));
