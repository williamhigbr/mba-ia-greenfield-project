import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { thumbnailKey } from '../src/videos/videos.constants';

describe('GET /videos/:id — metadados, streaming e download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM pgboss.job');
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function login(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        token = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  // Creates a draft via the API (resolving the owner's channel + original_key),
  // then promotes the row to the requested terminal state directly in the DB —
  // no real processing is needed to exercise the read endpoints.
  async function createVideo(
    accessToken: string,
    status: VideoStatus,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size: 1048576 })
      .expect(201);
    const id = (res.body as { id: string }).id;

    const video = await videoRepository.findOneByOrFail({ id });
    if (status === VideoStatus.READY) {
      video.status = VideoStatus.READY;
      video.upload_id = null;
      video.thumbnail_key = thumbnailKey(id);
      video.duration_seconds = 42;
      video.metadata = { width: 1920, height: 1080, codec: 'h264' };
    } else {
      video.status = status;
    }
    await videoRepository.save(video);
    return id;
  }

  it('1.1 returns metadata for a ready video (anonymous)', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createVideo(accessToken, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${id}`)
      .expect(200);

    const body = res.body as {
      status: string;
      durationSeconds: number;
      metadata: Record<string, unknown>;
      thumbnailUrl: string;
    };
    expect(body.status).toBe('ready');
    expect(typeof body.durationSeconds).toBe('number');
    expect(typeof body.metadata).toBe('object');
    expect(body.metadata).not.toBeNull();
    expect(typeof body.thumbnailUrl).toBe('string');
    expect(body.thumbnailUrl.length).toBeGreaterThan(0);
  });

  it('1.2 hides a non-ready video from an anonymous caller (VIDEO_NOT_FOUND)', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createVideo(accessToken, VideoStatus.PROCESSING);

    const res = await request(app.getHttpServer())
      .get(`/videos/${id}`)
      .expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  it('2.1 redirects streaming of a ready video to a presigned GET URL', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createVideo(accessToken, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .expect(302);

    expect(res.headers.location).toBeDefined();
    expect(res.headers.location).toContain('X-Amz-Signature');
  });

  it('2.2 redirects download with an attachment content-disposition', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createVideo(accessToken, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/download`)
      .expect(302);

    expect(res.headers.location).toBeDefined();
    expect(res.headers.location).toContain(
      'response-content-disposition=attachment',
    );
  });

  it('2.3 blocks streaming of a non-ready video (VIDEO_NOT_READY)', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createVideo(accessToken, VideoStatus.PROCESSING);

    const res = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .expect(409);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
  });
});
