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

interface DraftResult {
  id: string;
  parts: { partNumber: number; etag: string }[];
}

describe('POST /videos/:id/complete — completar upload (e2e)', () => {
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

  // Creates a draft via the API, PUTs a real part to the presigned URL and
  // returns the real ETag so completeMultipartUpload succeeds against MinIO.
  async function createDraftAndUpload(
    accessToken: string,
  ): Promise<DraftResult> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size: 1048576 })
      .expect(201);
    const body = res.body as {
      id: string;
      parts: { partNumber: number; url: string }[];
    };

    const payload = Buffer.alloc(1024, 7);
    const put = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: payload,
    });
    const etag = put.headers.get('etag') as string;

    return { id: body.id, parts: [{ partNumber: 1, etag }] };
  }

  it('1.1 completes the upload and transitions to processing', async () => {
    const accessToken = await login('owner@example.com');
    const draft = await createDraftAndUpload(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: draft.parts })
      .expect(200);

    expect(res.body).toEqual({ id: draft.id, status: 'processing' });

    const jobs = await dataSource.query<{ c: number }[]>(
      `SELECT count(*)::int AS c FROM pgboss.job WHERE name = 'video-process' AND data->>'videoId' = $1`,
      [draft.id],
    );
    expect(jobs[0].c).toBe(1);

    const video = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(video.status).toBe('processing');
    expect(video.upload_id).toBeNull();
  });

  it('1.2 rejects a non-owner with VIDEO_NOT_OWNER', async () => {
    const ownerToken = await login('owner@example.com');
    const draft = await createDraftAndUpload(ownerToken);
    const otherToken = await login('intruder@example.com');

    const res = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ parts: draft.parts })
      .expect(403);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_OWNER');

    const jobs = await dataSource.query<{ c: number }[]>(
      `SELECT count(*)::int AS c FROM pgboss.job WHERE data->>'videoId' = $1`,
      [draft.id],
    );
    expect(jobs[0].c).toBe(0);
    const video = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(video.status).toBe('draft');
  });

  it('1.3 rejects a video that is not in draft state with INVALID_UPLOAD_STATE', async () => {
    const accessToken = await login('owner@example.com');
    const draft = await createDraftAndUpload(accessToken);

    // First completion moves it to processing.
    await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: draft.parts })
      .expect(200);

    // Second completion must be rejected.
    const res = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: draft.parts })
      .expect(409);

    expect((res.body as { error: string }).error).toBe('INVALID_UPLOAD_STATE');
  });

  it('1.4 rejects a non-existent video with VIDEO_NOT_FOUND', async () => {
    const accessToken = await login('owner@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos/00000000-0000-0000-0000-000000000000/complete')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag: '"x"' }] })
      .expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  it('1.5 rejects an invalid body (ValidationPipe wiring)', async () => {
    const accessToken = await login('owner@example.com');
    const draft = await createDraftAndUpload(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(400);

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });
});
