import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaProcessorService } from './media-processor.service';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videoRepository: { findOne: jest.Mock; save: jest.Mock };
  let storageService: { downloadToFile: jest.Mock; putObject: jest.Mock };
  let mediaProcessor: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let savedVideo: Video | undefined;

  beforeEach(async () => {
    savedVideo = undefined;
    videoRepository = {
      findOne: jest.fn(() => Promise.resolve(null)),
      save: jest.fn((v: Video) => {
        savedVideo = v;
        return Promise.resolve(v);
      }),
    };
    storageService = {
      downloadToFile: jest.fn(() => Promise.resolve()),
      putObject: jest.fn(() => Promise.resolve()),
    };
    mediaProcessor = {
      probe: jest.fn(() =>
        Promise.resolve({ durationSeconds: 2, metadata: {} }),
      ),
      extractThumbnail: jest.fn(() => Promise.resolve()),
    };
    const queueService = { getBoss: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: QueueService, useValue: queueService },
        { provide: MediaProcessorService, useValue: mediaProcessor },
      ],
    }).compile();

    service = moduleRef.get(VideoProcessingService);
  });

  function video(overrides?: Partial<Video>): Video {
    return {
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      original_key: 'videos/video-1/original.mp4',
      ...overrides,
    } as Video;
  }

  describe('processVideo (idempotency, keyed by videoId)', () => {
    it('skips a video already in ready — no download, probe, or save (safe re-run)', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        video({ status: VideoStatus.READY }),
      );

      await service.processVideo('video-1');

      expect(storageService.downloadToFile).not.toHaveBeenCalled();
      expect(mediaProcessor.probe).not.toHaveBeenCalled();
      expect(mediaProcessor.extractThumbnail).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('is a no-op when the video no longer exists', async () => {
      videoRepository.findOne.mockResolvedValueOnce(null);

      await expect(service.processVideo('missing')).resolves.toBeUndefined();

      expect(storageService.downloadToFile).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('markFailed (dead-letter branch)', () => {
    it('sets the terminal failed status with a failure_reason', async () => {
      videoRepository.findOne.mockResolvedValueOnce(video());

      await service.markFailed('video-1');

      const saved = savedVideo as Video;
      expect(saved.status).toBe(VideoStatus.FAILED);
      expect(typeof saved.failure_reason).toBe('string');
      expect((saved.failure_reason as string).length).toBeGreaterThan(0);
    });

    it('records a custom reason when provided', async () => {
      videoRepository.findOne.mockResolvedValueOnce(video());

      await service.markFailed('video-1', 'ffprobe crashed');

      expect((savedVideo as Video).failure_reason).toBe('ffprobe crashed');
    });

    it('is a no-op when the video no longer exists', async () => {
      videoRepository.findOne.mockResolvedValueOnce(null);

      await service.markFailed('missing');

      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });
});
