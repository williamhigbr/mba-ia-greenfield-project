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
import { Video } from '../src/videos/entities/video.entity';

describe('POST /videos/:id/abort-upload — abortar upload (e2e)', () => {
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

  // Creates a draft via the API — this initiates a real multipart upload on
  // storage (returns a real UploadId), which is what abort releases.
  async function createDraft(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size: 1048576 })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  // Drives a draft all the way to `processing` (upload a real part + complete).
  async function createProcessingVideo(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size: 1048576 })
      .expect(201);
    const body = res.body as {
      id: string;
      parts: { partNumber: number; url: string }[];
    };
    const put = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: Buffer.alloc(1024, 7),
    });
    const etag = put.headers.get('etag') as string;
    await request(app.getHttpServer())
      .post(`/videos/${body.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);
    return body.id;
  }

  it('1.1 aborts a draft and removes the row', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createDraft(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/abort-upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    expect(res.body).toEqual({});

    const video = await videoRepository.findOneBy({ id });
    expect(video).toBeNull();
  });

  it('1.2 rejects a non-owner with VIDEO_NOT_OWNER and keeps the draft', async () => {
    const ownerToken = await login('owner@example.com');
    const id = await createDraft(ownerToken);
    const otherToken = await login('intruder@example.com');

    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/abort-upload`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_OWNER');

    const video = await videoRepository.findOneByOrFail({ id });
    expect(video.status).toBe('draft');
  });

  it('1.3 rejects a video that is not in draft state with INVALID_UPLOAD_STATE', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createProcessingVideo(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/abort-upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);

    expect((res.body as { error: string }).error).toBe('INVALID_UPLOAD_STATE');
  });

  it('1.4 requires authentication', async () => {
    const accessToken = await login('owner@example.com');
    const id = await createDraft(accessToken);

    await request(app.getHttpServer())
      .post(`/videos/${id}/abort-upload`)
      .expect(401);
  });
});
