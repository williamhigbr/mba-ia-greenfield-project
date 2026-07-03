import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // videos FK-cascades from channels, but delete explicitly first to keep the
    // cleanup order independent of cascade behavior.
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `chan_${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('persists status = draft by default when none is provided', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'clip.mp4',
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects a video without channel_id (NOT NULL constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          title: 'orphan.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a video referencing a non-existent channel (FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'ghost.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects an invalid status value (enum constraint)', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "title", "status") VALUES ($1, $2, $3)`,
        [channel.id, 'bad.mp4', 'not-a-real-status'],
      ),
    ).rejects.toThrow();
  });

  it('accepts all valid enum values', async () => {
    const channel = await createChannel();

    for (const status of Object.values(VideoStatus)) {
      const saved = await videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: `${status}.mp4`,
          status,
        }),
      );
      expect(saved.status).toBe(status);
    }
  });

  it('cascade-deletes videos when the owning channel is deleted', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({ channel_id: channel.id, title: 'a.mp4' }),
    );
    await videoRepository.save(
      videoRepository.create({ channel_id: channel.id, title: 'b.mp4' }),
    );

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(2);

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
  });

  it('loads the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create({ channel_id: channel.id, title: 'rel.mp4' }),
    );

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });
    expect(found?.channel.id).toBe(channel.id);
  });
});
