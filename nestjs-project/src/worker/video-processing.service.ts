import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  QueueService,
  VIDEO_PROCESS_DLQ,
  VIDEO_PROCESS_QUEUE,
  VideoProcessingJob,
} from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { thumbnailKey } from '../videos/videos.constants';
import { MediaProcessorService } from './media-processor.service';

/** Terminal failure reason recorded on the video when a job is dead-lettered. */
const DEAD_LETTER_REASON = 'Video processing failed after exhausting retries';

/**
 * Consumes the `video-process` queue: downloads the original from storage,
 * extracts duration/metadata (ffprobe) and a thumbnail (ffmpeg), uploads the
 * thumbnail and transitions the video to `ready`. A companion listener on the
 * dead-letter queue marks the video `failed` once retries are exhausted
 * (TD-04/05/08). The handler is idempotent, keyed by `videoId`.
 */
@Injectable()
export class VideoProcessingService implements OnModuleInit {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
    private readonly mediaProcessor: MediaProcessorService,
  ) {}

  async onModuleInit(): Promise<void> {
    const boss = this.queueService.getBoss();

    await boss.work<VideoProcessingJob>(VIDEO_PROCESS_QUEUE, async ([job]) => {
      await this.processVideo(job.data.videoId);
    });

    await boss.work<VideoProcessingJob>(VIDEO_PROCESS_DLQ, async ([job]) => {
      await this.markFailed(job.data.videoId);
    });

    this.logger.log(
      `Listening on '${VIDEO_PROCESS_QUEUE}' and '${VIDEO_PROCESS_DLQ}'`,
    );
  }

  /**
   * Processes one video. Idempotent by `videoId`: a video already `ready` is
   * skipped, and every side effect (thumbnail key, row fields) is deterministic
   * so a retry simply overwrites with the same result.
   */
  async processVideo(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found — nothing to process`);
      return;
    }
    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} already ready — skipping (idempotent)`);
      return;
    }
    if (!video.original_key) {
      throw new Error(`Video ${videoId} has no original_key`);
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const originalPath = join(workDir, 'original');
    const thumbPath = join(workDir, 'thumb.jpg');

    try {
      await this.storageService.downloadToFile(
        video.original_key,
        originalPath,
      );

      const { durationSeconds, metadata } =
        await this.mediaProcessor.probe(originalPath);

      // Grab the thumbnail from near the start, clamped to the clip length.
      const at = Math.min(1, Math.max(0, durationSeconds / 2));
      await this.mediaProcessor.extractThumbnail(originalPath, thumbPath, at);
      const thumbBuffer = await readFile(thumbPath);

      const thumbKey = thumbnailKey(videoId);
      await this.storageService.putObject(thumbKey, thumbBuffer, 'image/jpeg');

      video.status = VideoStatus.READY;
      video.duration_seconds = durationSeconds;
      video.metadata = metadata;
      video.thumbnail_key = thumbKey;
      video.failure_reason = null;
      await this.videoRepository.save(video);

      this.logger.log(
        `Video ${videoId} processed → ready (${durationSeconds}s)`,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Dead-letter handler: sets the terminal `failed` status with a reason once
   * `video-process` has exhausted its retries (TD-08).
   */
  async markFailed(
    videoId: string,
    reason: string = DEAD_LETTER_REASON,
  ): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found — cannot mark failed`);
      return;
    }
    video.status = VideoStatus.FAILED;
    video.failure_reason = reason;
    await this.videoRepository.save(video);
    this.logger.error(`Video ${videoId} marked failed: ${reason}`);
  }
}
