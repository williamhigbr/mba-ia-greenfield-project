import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  VideoNotFoundException,
  VideoNotOwnerException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { PresignedPart, StorageService } from '../storage/storage.service';
import type { JwtPayload } from '../auth/auth.types';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { MAX_VIDEO_SIZE_BYTES, originalKey } from './videos.constants';

export interface CreateDraftUploadResult {
  id: string;
  uploadId: string;
  key: string;
  partSize: number;
  parts: PresignedPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * Pre-registers the video as a `draft`, initiates the S3 multipart upload and
   * returns one presigned PUT URL per part. The browser uploads the 10GB
   * directly to storage — bytes never transit the API (TD-02/06/08).
   */
  async createDraftUpload(
    user: JwtPayload,
    dto: CreateVideoDto,
  ): Promise<CreateDraftUploadResult> {
    if (dto.size > MAX_VIDEO_SIZE_BYTES) {
      throw new FileTooLargeException();
    }
    if (!this.isVideoContentType(dto.contentType)) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      // Invariant: every authenticated user has a channel (created at signup).
      throw new Error(`No channel found for user ${user.sub}`);
    }

    // The uuid PK doubles as the public URL id (TD-06) — generate it up front
    // so the storage key can embed it before the row is persisted.
    const id = randomUUID();
    const key = originalKey(id, this.extractExtension(dto.filename));

    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.contentType,
    );
    const partCount = Math.ceil(dto.size / this.storageService.partSize);
    const parts = await this.storageService.presignPartUrls(
      key,
      uploadId,
      partCount,
    );

    await this.videoRepository.save(
      this.videoRepository.create({
        id,
        channel_id: channel.id,
        title: this.deriveTitle(dto.filename),
        status: VideoStatus.DRAFT,
        upload_id: uploadId,
        original_key: key,
        content_type: dto.contentType,
        size_bytes: String(dto.size),
      }),
    );

    return {
      id,
      uploadId,
      key,
      partSize: this.storageService.partSize,
      parts,
    };
  }

  /**
   * Completes the multipart upload, transitions draft → processing and enqueues
   * the processing job. Owner-only; only valid while the video is `draft`.
   */
  async completeUpload(
    user: JwtPayload,
    id: string,
    dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.loadOwnedVideo(user, id);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException();
    }

    await this.storageService.completeMultipartUpload(
      video.original_key as string,
      video.upload_id as string,
      dto.parts,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.queueService.enqueueVideoProcessing(video.id);

    return { id: video.id, status: video.status };
  }

  /**
   * Loads a video and asserts the caller owns it. Throws VIDEO_NOT_FOUND when
   * absent and VIDEO_NOT_OWNER when it belongs to another channel.
   */
  private async loadOwnedVideo(user: JwtPayload, id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel || video.channel_id !== channel.id) {
      throw new VideoNotOwnerException();
    }
    return video;
  }

  private isVideoContentType(contentType: string): boolean {
    return /^video\//i.test(contentType);
  }

  private extractExtension(filename: string): string {
    const dot = filename.lastIndexOf('.');
    if (dot > 0 && dot < filename.length - 1) {
      return filename.slice(dot + 1).toLowerCase();
    }
    return 'bin';
  }

  private deriveTitle(filename: string): string {
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    return base.slice(0, 255);
  }
}
