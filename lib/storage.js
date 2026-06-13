const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const r2Config = {
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
};

const s3Client = new S3Client(r2Config);
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'app-storage';

/**
 * Upload a buffer or stream to R2
 */
const uploadToR2 = async (fileBuffer, fileName, contentType) => {
  const key = `uploads/${crypto.randomUUID()}-${fileName}`;
  
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'public-read', // Depends on bucket settings
  });

  try {
    await s3Client.send(command);
    // Construct the public URL. R2 public URLs usually follow: https://<pub-hash>.r2.dev/<key>
    // Or if using a custom domain: https://cdn.example.com/<key>
    // For now, we'll return the path and assume the frontend knows the base URL or we use the endpoint.
    return {
      key: key,
      url: `${process.env.R2_PUBLIC_URL}/${key}`,
      success: true
    };
  } catch (error) {
    console.error('[STORAGE] Upload error:', error);
    throw error;
  }
};

/**
 * Generate a presigned URL for direct client-side upload (more efficient)
 */
const getPresignedUploadUrl = async (fileName, contentType) => {
  const key = `uploads/${crypto.randomUUID()}-${fileName}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  try {
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return {
      uploadUrl: signedUrl,
      fileUrl: `${process.env.R2_PUBLIC_URL}/${key}`,
      key: key
    };
  } catch (error) {
    console.error('[STORAGE] Presigned URL error:', error);
    throw error;
  }
};

/**
 * Deterministic upload for KYC documents (allows overwriting)
 */
const uploadKycDocument = async (vendorId, docType, fileBuffer, fileName, contentType) => {
  const extension = fileName.split('.').pop();
  const key = `kyc/${vendorId}/${docType}.${extension}`;
  
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'public-read',
  });

  try {
    await s3Client.send(command);
    return {
      key: key,
      url: `${process.env.R2_PUBLIC_URL}/${key}`,
      success: true
    };
  } catch (error) {
    console.error('[STORAGE] KYC Upload error:', error);
    throw error;
  }
};

module.exports = {
  uploadToR2,
  getPresignedUploadUrl,
  uploadKycDocument
};
