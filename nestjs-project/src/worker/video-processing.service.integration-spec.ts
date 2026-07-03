import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { originalKey, thumbnailKey } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

/**
 * Integration: boots the real WorkerModule application context (pg-boss + DB +
 * MinIO on the Compose network), uploads a real sample video, enqueues a job
 * and asserts the worker drives it processing → ready with extracted duration,
 * metadata and a generated thumbnail. Requires the `ffmpeg`/`ffprobe` binaries
 * (present in this image via Dockerfile).
 */
describe('VideoProcessingService (integration)', () => {
  let app: INestApplicationContext;
  let dataSource: DataSource;
  let storageService: StorageService;
  let queueService: QueueService;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    dataSource = app.get(DataSource);
    storageService = app.get(StorageService);
    queueService = app.get(QueueService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedProcessingVideo(): Promise<string> {
    // FK order: videos → channels → users; plus the queue table.
    await dataSource.query('DELETE FROM pgboss.job');
    // CASCADE also clears channels, videos, refresh_tokens, verification_tokens.
    await dataSource.query('TRUNCATE TABLE "users" CASCADE');

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const videoRepo = dataSource.getRepository(Video);

    const user = await userRepo.save(
      userRepo.create({
        email: `worker-${randomUUID()}@example.com`,
        password: 'irrelevant-hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Worker Channel',
        nickname: `wc-${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );

    const id = randomUUID();
    await videoRepo.save(
      videoRepo.create({
        id,
        channel_id: channel.id,
        title: 'sample',
        status: VideoStatus.PROCESSING,
        original_key: originalKey(id, 'mp4'),
        content_type: 'video/mp4',
      }),
    );
    return id;
  }

  it('processes a real job end-to-end: processing → ready with duration, metadata and thumbnail', async () => {
    const id = await seedProcessingVideo();
    const key = originalKey(id, 'mp4');

    const bytes = await readFile(
      join(__dirname, '..', '..', 'test', 'fixtures', 'sample.mp4'),
    );
    await storageService.putObject(key, bytes, 'video/mp4');

    const jobId = await queueService.enqueueVideoProcessing(id);
    expect(jobId).toBeTruthy();

    const videoRepo = dataSource.getRepository(Video);
    const deadline = Date.now() + 45_000;
    let video = await videoRepo.findOneByOrFail({ id });
    while (video.status === VideoStatus.PROCESSING && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      video = await videoRepo.findOneByOrFail({ id });
    }

    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.thumbnail_key).toBe(thumbnailKey(id));
    expect(video.metadata).toMatchObject({
      width: 320,
      height: 240,
      codec: 'h264',
    });

    // The generated thumbnail is retrievable from storage.
    const thumbUrl = await storageService.presignGetUrl(thumbnailKey(id));
    const res = await fetch(thumbUrl);
    expect(res.status).toBe(200);
  }, 60_000);
});
