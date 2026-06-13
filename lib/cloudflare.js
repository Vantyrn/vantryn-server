const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

/**
 * Cloudflare R2 Utility
 * Manages secure uploads and URL generation for manual R2 setup.
 */

// Initialize the S3-compatible client for Cloudflare R2
const r2Config = {
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT, // e.g., https://<accountid>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
};

const s3Client = new S3Client(r2Config);

/**
 * Generate a presigned URL for direct client-side upload to R2
 * @param {string} fileName - The desired name/path of the file in the bucket
 * @param {string} contentType - The MIME type of the file
 * @param {number} expiresIn - Expiration time in seconds (default 300s = 5 mins)
 */
async function generatePresignedUrl(fileName, contentType, expiresIn = 300) {
    try {
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileName,
            ContentType: contentType,
        });

        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
        
        // Return both the upload URL and the final public URL
        const publicUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
        
        return {
            uploadUrl: signedUrl,
            publicUrl: publicUrl
        };
    } catch (error) {
        console.error('[CLOUDFLARE-R2] Presigned URL Generation Failed:', error);
        throw error;
    }
}

module.exports = {
    generatePresignedUrl,
    s3Client
};
