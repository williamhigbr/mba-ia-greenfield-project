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
  VideoNotReadyException,
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

export interface VideoView {
  id: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  metadata: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  createdAt: string;
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
   * Cancels an in-progress multipart upload: releases the parts on storage and
   * removes the draft row. Owner-only; only valid while the video is `draft`
   * (TD-02).
   */
  async abortUpload(user: JwtPayload, id: string): Promise<void> {
    const video = await this.loadOwnedVideo(user, id);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidUploadStateException();
    }

    await this.storageService.abortMultipartUpload(
      video.original_key as string,
      video.upload_id as string,
    );

    await this.videoRepository.remove(video);
  }

  /**
   * Returns the public metadata view of a video, applying the visibility rule:
   * the owner sees any status; anonymous/non-owner callers only see `ready`
   * videos (otherwise `VIDEO_NOT_FOUND`). The `thumbnailUrl` is a freshly
   * presigned GET URL, present only once the video is `ready` (TD-06/07).
   */
  async getVideoView(id: string, user?: JwtPayload): Promise<VideoView> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) {
      throw new VideoNotFoundException();
    }

    if (
      video.status !== VideoStatus.READY &&
      !(await this.isOwner(video, user))
    ) {
      // Hide the very existence of non-ready videos from non-owners.
      throw new VideoNotFoundException();
    }

    let thumbnailUrl: string | null = null;
    if (video.status === VideoStatus.READY && video.thumbnail_key) {
      thumbnailUrl = await this.storageService.presignGetUrl(
        video.thumbnail_key,
      );
    }

    return {
      id: video.id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      createdAt: video.created_at.toISOString(),
    };
  }

  /**
   * Presigned GET URL for streaming. Storage serves HTTP Range / 206 natively —
   * the controller 302-redirects the browser straight to storage (TD-07).
   * Requires `status = ready`.
   */
  async getStreamRedirect(id: string): Promise<string> {
    const video = await this.loadReadyVideo(id);
    return this.storageService.presignGetUrl(video.original_key as string);
  }

  /**
   * Presigned GET URL for download — same as streaming but with an
   * `attachment` content-disposition so the browser downloads the file
   * (TD-07). Requires `status = ready`.
   */
  async getDownloadRedirect(id: string): Promise<string> {
    const video = await this.loadReadyVideo(id);
    return this.storageService.presignGetUrl(video.original_key as string, {
      downloadFilename: this.downloadFilename(video),
    });
  }

  /** Loads a video and asserts it is `ready`, else VIDEO_NOT_FOUND / NOT_READY. */
  private async loadReadyVideo(id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  /** True when a caller is present and owns the video's channel. */
  private async isOwner(video: Video, user?: JwtPayload): Promise<boolean> {
    if (!user) {
      return false;
    }
    const channel = await this.channelsService.findByUserId(user.sub);
    return !!channel && video.channel_id === channel.id;
  }

  /** Suggested download filename: video title + the original file extension. */
  private downloadFilename(video: Video): string {
    const key = video.original_key ?? '';
    const dot = key.lastIndexOf('.');
    const ext = dot > 0 ? key.slice(dot + 1) : 'mp4';
    const safeTitle = video.title.replace(/[^\w.\- ]+/g, '_').trim() || 'video';
    return `${safeTitle}.${ext}`;
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
