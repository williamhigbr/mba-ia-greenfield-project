import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CreateDraftUploadResult,
  VideoView,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pre-register a video and start its upload',
    description:
      'Creates the video as a draft, initiates the S3 multipart upload and ' +
      'returns one presigned PUT URL per part. The browser uploads the file ' +
      'directly to object storage — bytes never pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        uploadId: { type: 'string' },
        key: { type: 'string' },
        partSize: { type: 'number' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or file exceeds 10GB (FILE_TOO_LARGE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not video/* (UNSUPPORTED_MEDIA_TYPE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftUploadResult> {
    return this.videosService.createDraftUpload(user, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Assembles the uploaded parts on storage, transitions the video from ' +
      'draft to processing and enqueues the processing job. Owner-only.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is now processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video does not belong to the caller (VIDEO_NOT_OWNER)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft state (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: string }> {
    return this.videosService.completeUpload(user, id, dto);
  }

  @Post(':id/abort-upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort an in-progress upload',
    description:
      'Cancels the multipart upload, releases the uploaded parts on storage ' +
      'and removes the draft video. Owner-only; only valid while draft.',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload aborted; draft removed',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video does not belong to the caller (VIDEO_NOT_OWNER)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft state (INVALID_UPLOAD_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user, id);
  }

  @Get(':id')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a video’s metadata',
    description:
      'Returns the video metadata and processing status. Anonymous callers ' +
      'only see a video once it is ready; the owner sees any status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'failed'],
        },
        durationSeconds: { type: 'number', nullable: true },
        metadata: { type: 'object', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or not visible to the caller (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<VideoView> {
    return this.videosService.getVideoView(id, user);
  }

  @Get(':id/stream')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Issues a short-lived presigned GET URL and 302-redirects to it; the ' +
      'browser streams directly from storage (native Range/206). Requires ready.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned GET URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('id') id: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamRedirect(id);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':id/download')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Same as streaming, but the presigned GET URL carries an attachment ' +
      'content-disposition so the browser downloads the file. Requires ready.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned GET (attachment) URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('id') id: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadRedirect(id);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
