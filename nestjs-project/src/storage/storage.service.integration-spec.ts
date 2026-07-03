import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Integration: real contract against the MinIO service on the Compose network
 * (`minio:9000`). Bytes are PUT/GET directly against storage via presigned
 * URLs — never through the API.
 */
describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  function newKey(): string {
    return `test/storage/${randomUUID()}/original.bin`;
  }

  it('createMultipartUpload returns a non-empty uploadId', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(key);
    expect(typeof uploadId).toBe('string');
    expect(uploadId.length).toBeGreaterThan(0);
    await service.abortMultipartUpload(key, uploadId);
  });

  it('create → presign → PUT part → complete assembles a retrievable object', async () => {
    const key = newKey();
    const payload = Buffer.from('hello streamtube multipart payload');

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const parts = await service.presignPartUrls(key, uploadId, 1);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ partNumber: 1 });
    expect(typeof parts[0].url).toBe('string');

    // Browser-equivalent: PUT the part bytes directly to the presigned URL.
    const putRes = await fetch(parts[0].url, { method: 'PUT', body: payload });
    expect(putRes.status).toBe(200);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    // The assembled object is retrievable via a presigned GET.
    const getUrl = await service.presignGetUrl(key);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    const body = Buffer.from(await getRes.arrayBuffer());
    expect(body.equals(payload)).toBe(true);

    await service.deleteObject(key);
  });

  it('abortMultipartUpload removes the pending parts (final object absent)', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(key);
    const [part] = await service.presignPartUrls(key, uploadId, 1);
    await fetch(part.url, { method: 'PUT', body: Buffer.from('abandoned') });

    await service.abortMultipartUpload(key, uploadId);

    // No final object was ever assembled — a presigned GET must 404.
    const getUrl = await service.presignGetUrl(key);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(404);
  });

  it('presignGetUrl download mode carries response-content-disposition=attachment', async () => {
    const key = newKey();
    const url = await service.presignGetUrl(key, {
      downloadFilename: 'my video.mp4',
    });
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('response-content-disposition=');
    expect(decoded).toContain('attachment');
  });

  it('putObject uploads a small object retrievable via presigned GET (thumbnail path)', async () => {
    const key = `test/thumbnails/${randomUUID()}/thumb.jpg`;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await service.putObject(key, bytes, 'image/jpeg');

    const getUrl = await service.presignGetUrl(key);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    const body = Buffer.from(await getRes.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);

    await service.deleteObject(key);
  });
});
