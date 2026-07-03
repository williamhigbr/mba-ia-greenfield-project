import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  type CompletedPart,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

/** Presigned URLs are short-lived — the API gates issuance (auth), storage
 * enforces expiry. One hour is enough for a browser to PUT a part or start
 * streaming (TD-02/07). */
const PRESIGN_EXPIRY_SECONDS = 3600;

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * Single entry point for all object-storage access (MinIO/S3). Bytes never
 * transit the API: uploads are presigned multipart PUTs and playback/download
 * are presigned GETs served directly by storage (TD-02/03/07). Only object
 * KEYS are ever persisted — every access is a freshly-signed URL.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true, // REQUIRED for MinIO (path-style addressing)
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  /** Byte size of each multipart part (last part may be smaller). */
  get partSize(): number {
    return this.config.partSize;
  }

  /** Initiates a multipart upload and returns the S3 UploadId. */
  async createMultipartUpload(
    key: string,
    contentType?: string,
  ): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error('S3 did not return an UploadId for the multipart upload');
    }
    return res.UploadId;
  }

  /** One presigned PUT URL per part — the browser uploads bytes directly. */
  async presignPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: PRESIGN_EXPIRY_SECONDS },
      );
      parts.push({ partNumber, url });
    }
    return parts;
  }

  /** Assembles the uploaded parts into the final object. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const completedParts: CompletedPart[] = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ ETag: p.etag, PartNumber: p.partNumber }));

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }),
    );
  }

  /** Cancels an in-progress multipart upload and releases its parts. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Presigned GET URL. In download mode a `ResponseContentDisposition:
   * attachment` header makes the browser download instead of streaming inline
   * (TD-07). Storage serves HTTP Range / 206 natively for streaming.
   */
  async presignGetUrl(
    key: string,
    options?: { downloadFilename?: string },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options?.downloadFilename
        ? {
            ResponseContentDisposition: `attachment; filename="${options.downloadFilename}"`,
          }
        : {}),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
  }

  /** Uploads a small object directly (used for generated thumbnails). */
  async putObject(
    key: string,
    body: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Deletes an object by key. */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Streams an object to a local file path. Used by the worker to fetch the
   * original before shelling out to ffprobe/ffmpeg, which operate on files
   * (TD-05). Streaming avoids buffering multi-GB videos in memory.
   */
  async downloadToFile(key: string, destPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = res.Body;
    if (!body) {
      throw new Error(`Storage object ${key} has no body`);
    }
    await pipeline(body as Readable, createWriteStream(destPath));
  }
}
