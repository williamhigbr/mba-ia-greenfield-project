import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { JwtPayload } from '../auth/auth.types';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  VideoNotFoundException,
  VideoNotOwnerException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let storageService: {
    partSize: number;
    createMultipartUpload: jest.Mock;
    presignPartUrls: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let queueService: { enqueueVideoProcessing: jest.Mock };
  let savedVideo: Video | undefined;

  const user: JwtPayload = { sub: 'user-1', email: 'u@example.com' };
  const channel = { id: 'channel-1' };

  beforeEach(async () => {
    savedVideo = undefined;
    videoRepository = {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Video) => {
        savedVideo = v;
        return Promise.resolve(v);
      }),
      findOne: jest.fn(() => Promise.resolve(null)),
    };
    storageService = {
      partSize: 100 * 1024 * 1024, // 100MB
      createMultipartUpload: jest.fn(() => Promise.resolve('upload-123')),
      presignPartUrls: jest.fn((_k: string, _u: string, count: number) =>
        Promise.resolve(
          Array.from({ length: count }, (_v, i) => ({
            partNumber: i + 1,
            url: `https://storage/part-${i + 1}`,
          })),
        ),
      ),
      completeMultipartUpload: jest.fn(() => Promise.resolve()),
    };
    channelsService = {
      findByUserId: jest.fn(() => Promise.resolve(channel)),
    };
    queueService = {
      enqueueVideoProcessing: jest.fn(() => Promise.resolve('job-1')),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  function dto(overrides?: Partial<CreateVideoDto>): CreateVideoDto {
    return {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      size: 50 * 1024 * 1024, // 50MB
      ...overrides,
    };
  }

  describe('createDraftUpload', () => {
    it('throws FILE_TOO_LARGE when size exceeds 10GB and never touches storage', async () => {
      await expect(
        service.createDraftUpload(
          user,
          dto({ size: 10 * 1024 * 1024 * 1024 + 1 }),
        ),
      ).rejects.toBeInstanceOf(FileTooLargeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('throws UNSUPPORTED_MEDIA_TYPE when contentType is not video/*', async () => {
      await expect(
        service.createDraftUpload(
          user,
          dto({ contentType: 'application/pdf' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('creates a draft, initiates multipart, and returns presigned parts (happy path)', async () => {
      const result = await service.createDraftUpload(user, dto());

      expect(result.id).toEqual(expect.any(String));
      expect(result.uploadId).toBe('upload-123');
      expect(result.key).toBe(`videos/${result.id}/original.mp4`);
      expect(result.partSize).toBe(storageService.partSize);
      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://storage/part-1' },
      ]);

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        result.key,
        'video/mp4',
      );
      expect(storageService.presignPartUrls).toHaveBeenCalledWith(
        result.key,
        'upload-123',
        1,
      );

      const saved = savedVideo as Video;
      expect(saved).toMatchObject({
        id: result.id,
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-123',
        original_key: result.key,
        content_type: 'video/mp4',
        size_bytes: String(50 * 1024 * 1024),
      });
    });

    it('computes the part count from size / partSize', async () => {
      // 250MB / 100MB → 3 parts
      await service.createDraftUpload(user, dto({ size: 250 * 1024 * 1024 }));
      expect(storageService.presignPartUrls).toHaveBeenCalledWith(
        expect.any(String),
        'upload-123',
        3,
      );
    });
  });

  describe('completeUpload', () => {
    const completeDto = { parts: [{ partNumber: 1, etag: '"abc"' }] };

    function draftVideo(overrides?: Partial<Video>): Video {
      return {
        id: 'video-1',
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-123',
        original_key: 'videos/video-1/original.mp4',
        ...overrides,
      } as Video;
    }

    it('throws VIDEO_NOT_FOUND when no video matches the id', async () => {
      videoRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.completeUpload(user, 'missing', completeDto),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(queueService.enqueueVideoProcessing).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_OWNER when the video belongs to another channel', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        draftVideo({ channel_id: 'other-channel' }),
      );
      await expect(
        service.completeUpload(user, 'video-1', completeDto),
      ).rejects.toBeInstanceOf(VideoNotOwnerException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queueService.enqueueVideoProcessing).not.toHaveBeenCalled();
    });

    it('throws INVALID_UPLOAD_STATE when the video is not a draft', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        draftVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(
        service.completeUpload(user, 'video-1', completeDto),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);
      expect(queueService.enqueueVideoProcessing).not.toHaveBeenCalled();
    });

    it('completes the multipart, transitions to processing, clears upload_id and enqueues', async () => {
      videoRepository.findOne.mockResolvedValueOnce(draftVideo());

      const result = await service.completeUpload(user, 'video-1', completeDto);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-123',
        completeDto.parts,
      );
      expect(queueService.enqueueVideoProcessing).toHaveBeenCalledWith(
        'video-1',
      );
      expect(result).toEqual({ id: 'video-1', status: VideoStatus.PROCESSING });

      const saved = savedVideo as Video;
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
    });
  });
});
