/** Maximum accepted upload size: 10GB in bytes. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10737418240

/** Deterministic object-key prefixes keyed by video id (TD-03). */
export const ORIGINAL_KEY_PREFIX = 'videos';
export const THUMBNAIL_KEY_PREFIX = 'thumbnails';

export function originalKey(videoId: string, ext: string): string {
  return `${ORIGINAL_KEY_PREFIX}/${videoId}/original.${ext}`;
}

export function thumbnailKey(videoId: string): string {
  return `${THUMBNAIL_KEY_PREFIX}/${videoId}/thumb.jpg`;
}
