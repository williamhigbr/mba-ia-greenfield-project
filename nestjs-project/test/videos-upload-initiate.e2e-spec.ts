import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

describe('POST /videos — pré-cadastro e início do upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
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
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email = 'uploader@example.com',
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
    const body = res.body as { access_token: string };
    return body.access_token;
  }

  it('1.1 creates a draft and returns presigned parts', async () => {
    const email = 'uploader@example.com';
    const accessToken = await registerConfirmAndLogin(email);

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size: 52428800 })
      .expect(201);

    const body = res.body as {
      id: string;
      uploadId: string;
      key: string;
      partSize: number;
      parts: { partNumber: number; url: string }[];
    };
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(typeof body.uploadId).toBe('string');
    expect(body.uploadId.length).toBeGreaterThan(0);
    expect(typeof body.key).toBe('string');
    expect(typeof body.partSize).toBe('number');
    expect(Array.isArray(body.parts)).toBe(true);
    expect(typeof body.parts[0].partNumber).toBe('number');
    expect(typeof body.parts[0].url).toBe('string');

    const user = await userRepository.findOneByOrFail({ email });
    const channel = await channelRepository.findOneByOrFail({
      user_id: user.id,
    });
    const video = await videoRepository.findOneByOrFail({ id: body.id });
    expect(video.status).toBe('draft');
    expect(video.channel_id).toBe(channel.id);
  });

  it('1.2 rejects a file larger than 10GB with FILE_TOO_LARGE', async () => {
    const accessToken = await registerConfirmAndLogin();

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'big.mp4',
        contentType: 'video/mp4',
        size: 10737418241,
      })
      .expect(400);

    expect((res.body as { error: string }).error).toBe('FILE_TOO_LARGE');
    expect(await videoRepository.count()).toBe(0);
  });

  it('1.3 rejects a non-video content type with UNSUPPORTED_MEDIA_TYPE', async () => {
    const accessToken = await registerConfirmAndLogin();

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 })
      .expect(415);

    expect((res.body as { error: string }).error).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('1.4 requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', size: 1024 })
      .expect(401);
  });

  it('1.5 rejects an invalid body (ValidationPipe wiring)', async () => {
    const accessToken = await registerConfirmAndLogin();

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(400);

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });
});
