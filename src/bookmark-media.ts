import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { ensureDir, pathExists, readJson, readJsonLines, writeJson } from './fs.js';
import { bookmarkMediaDir, bookmarkMediaManifestPath, twitterBookmarksCachePath } from './paths.js';
import type { BookmarkRecord } from './types.js';

export const DEFAULT_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

export interface MediaFetchEntry {
  bookmarkId: string;
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  sourceUrl: string;
  localPath?: string;
  r2Key?: string;
  r2Url?: string;
  contentType?: string;
  bytes?: number;
  status: 'downloaded' | 'skipped_too_large' | 'failed';
  reason?: string;
  fetchedAt: string;
}

export interface MediaFetchManifest {
  schemaVersion: 1;
  generatedAt: string;
  limit: number;
  maxBytes: number;
  processed: number;
  downloaded: number;
  skippedTooLarge: number;
  failed: number;
  uploaded: number;
  deletedLocal: number;
  entries: MediaFetchEntry[];
}

export interface MediaFetchProgress {
  candidateBookmarks: number;
  processed: number;
  downloaded: number;
  uploaded: number;
  deletedLocal: number;
  skippedTooLarge: number;
  failed: number;
  currentSourceUrl?: string;
}

interface MediaFetchTarget {
  bookmarkId: string;
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  sourceUrl: string;
  isProfileImage: boolean;
}

interface MediaTargetSource {
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  authorProfileImageUrl?: string;
  media?: string[];
  mediaObjects?: BookmarkRecord['mediaObjects'];
}

interface CachedMediaResult {
  localPath?: string;
  r2Key?: string;
  r2Url?: string;
  contentType?: string;
  bytes?: number;
  status: MediaFetchEntry['status'];
  reason?: string;
  fetchedAt: string;
}

interface R2UploadConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  publicBaseUrl?: string;
  prefix: string;
}

function mediaEntryKey(tweetId: string, sourceUrl: string, isProfileImage: boolean): string {
  return isProfileImage ? `profile::${sourceUrl}` : `${tweetId}::${sourceUrl}`;
}

function mediaEntryKeyFromEntry(entry: MediaFetchEntry): string {
  return mediaEntryKey(entry.tweetId, entry.sourceUrl, entry.sourceUrl.includes('/profile_images/'));
}

function sanitizeExtFromContentType(contentType?: string, sourceUrl?: string): string {
  if (contentType?.includes('jpeg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('mp4')) return '.mp4';
  try {
    const ext = path.extname(new URL(sourceUrl ?? '').pathname);
    if (ext) return ext;
  } catch {}
  return '.bin';
}

function resolveR2Config(): R2UploadConfig {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 upload requires R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY');
  }
  const endpoint = (process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const prefix = (process.env.R2_PREFIX ?? 'fieldtheory/bookmarks/media').replace(/^\/+|\/+$/g, '');
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    prefix,
  };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function encodeS3PathPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Key(key: string): string {
  return key.split('/').map(encodeS3PathPart).join('/');
}

async function uploadToR2(config: R2UploadConfig, key: string, body: Buffer, contentType?: string): Promise<string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const encodedKey = encodeS3Key(key);
  const url = new URL(`${config.endpoint}/${encodeS3PathPart(config.bucket)}/${encodedKey}`);
  const host = url.host;
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    'PUT',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(body) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`R2 upload failed HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return config.publicBaseUrl ? `${config.publicBaseUrl}/${encodedKey}` : url.toString();
}

async function loadManifest(): Promise<MediaFetchManifest | null> {
  const manifestPath = bookmarkMediaManifestPath();
  if (!(await pathExists(manifestPath))) return null;
  return readJson<MediaFetchManifest>(manifestPath);
}

function hasTargets(source: { media?: unknown[]; mediaObjects?: unknown[]; authorProfileImageUrl?: string } | undefined): boolean {
  if (!source) return false;
  return (source.media?.length ?? 0) > 0 || (source.mediaObjects?.length ?? 0) > 0 || Boolean(source.authorProfileImageUrl);
}

function hasMediaCandidate(bookmark: BookmarkRecord): boolean {
  return hasTargets(bookmark) || hasTargets(bookmark.quotedTweet);
}

function pushTarget(
  targets: MediaFetchTarget[],
  seenKeys: Set<string>,
  base: Omit<MediaFetchTarget, 'sourceUrl' | 'isProfileImage'>,
  sourceUrl: string | undefined,
  isProfileImage: boolean,
): void {
  if (!sourceUrl) return;
  const key = mediaEntryKey(base.tweetId, sourceUrl, isProfileImage);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  targets.push({
    ...base,
    sourceUrl,
    isProfileImage,
  });
}

function appendMediaTargets(
  targets: MediaFetchTarget[],
  seenKeys: Set<string>,
  bookmarkId: string,
  source: MediaTargetSource,
  downloadedProfileImageUrls: Set<string>,
  skipProfileImages: boolean,
): void {
  const base = {
    bookmarkId,
    tweetId: source.tweetId,
    tweetUrl: source.tweetUrl,
    authorHandle: source.authorHandle,
    authorName: source.authorName,
  };

  if (source.mediaObjects?.length) {
    for (const mo of source.mediaObjects) {
      const previewUrl = mo.previewUrl ?? mo.url ?? mo.mediaUrl;
      if (mo.type === 'video' || mo.type === 'animated_gif') {
        pushTarget(targets, seenKeys, base, previewUrl, false);
        const mp4s = (mo.videoVariants ?? mo.variants ?? [])
          .filter((v) => v.url && (!v.contentType || v.contentType === 'video/mp4'))
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
        pushTarget(targets, seenKeys, base, mp4s[0]?.url, false);
        continue;
      }
      pushTarget(targets, seenKeys, base, previewUrl, false);
    }
  } else {
    for (const mediaUrl of source.media ?? []) {
      pushTarget(targets, seenKeys, base, mediaUrl, false);
    }
  }

  if (source.authorProfileImageUrl && !skipProfileImages) {
    const fullUrl = source.authorProfileImageUrl.replace('_normal.', '_400x400.');
    if (!downloadedProfileImageUrls.has(fullUrl)) {
      pushTarget(targets, seenKeys, base, fullUrl, true);
    }
  }
}

function resolveMediaTargets(
  bookmark: BookmarkRecord,
  downloadedProfileImageUrls: Set<string>,
  skipProfileImages: boolean,
): MediaFetchTarget[] {
  const targets: MediaFetchTarget[] = [];
  const seenKeys = new Set<string>();

  appendMediaTargets(targets, seenKeys, bookmark.id, {
    tweetId: bookmark.tweetId,
    tweetUrl: bookmark.url,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    authorProfileImageUrl: bookmark.authorProfileImageUrl,
    media: bookmark.media,
    mediaObjects: bookmark.mediaObjects,
  }, downloadedProfileImageUrls, skipProfileImages);

  if (bookmark.quotedTweet) {
    appendMediaTargets(targets, seenKeys, bookmark.id, {
      tweetId: bookmark.quotedTweet.id,
      tweetUrl: bookmark.quotedTweet.url,
      authorHandle: bookmark.quotedTweet.authorHandle,
      authorName: bookmark.quotedTweet.authorName,
      authorProfileImageUrl: bookmark.quotedTweet.authorProfileImageUrl,
      media: bookmark.quotedTweet.media,
      mediaObjects: bookmark.quotedTweet.mediaObjects,
    }, downloadedProfileImageUrls, skipProfileImages);
  }

  return targets;
}

function isCoveredEntry(entry: MediaFetchEntry, maxBytes: number, requireR2: boolean): boolean {
  if (entry.status === 'downloaded') return requireR2 ? Boolean(entry.r2Key) : true;
  if (entry.status !== 'skipped_too_large') return false;
  return typeof entry.bytes === 'number' && !Number.isNaN(entry.bytes) && entry.bytes > maxBytes;
}

function buildCoveredAssetKeys(previous: MediaFetchManifest | null, maxBytes: number, requireR2: boolean): Set<string> {
  return new Set(
    (previous?.entries ?? [])
      .filter((entry) => !entry.sourceUrl.includes('/profile_images/'))
      .filter((entry) => isCoveredEntry(entry, maxBytes, requireR2))
      .map((entry) => `${entry.tweetId}::${entry.sourceUrl}`),
  );
}

function buildCoveredProfileImageUrls(previous: MediaFetchManifest | null, maxBytes: number, requireR2: boolean): Set<string> {
  return new Set(
    (previous?.entries ?? [])
      .filter((entry) => entry.sourceUrl.includes('/profile_images/'))
      .filter((entry) => isCoveredEntry(entry, maxBytes, requireR2))
      .map((entry) => entry.sourceUrl),
  );
}

function hasPendingMediaTarget(
  bookmark: BookmarkRecord,
  coveredAssetKeys: Set<string>,
  coveredProfileImageUrls: Set<string>,
  skipProfileImages: boolean,
): boolean {
  return resolveMediaTargets(bookmark, coveredProfileImageUrls, skipProfileImages).some(({ tweetId, sourceUrl, isProfileImage }) => {
    if (isProfileImage) return true;
    return !coveredAssetKeys.has(`${tweetId}::${sourceUrl}`);
  });
}

export async function fetchBookmarkMediaBatch(
  options: {
    limit?: number;
    maxBytes?: number;
    skipProfileImages?: boolean;
    uploadR2?: boolean;
    deleteLocalAfterUpload?: boolean;
    onProgress?: (progress: MediaFetchProgress) => void;
  } = {}
): Promise<MediaFetchManifest> {
  const limit = typeof options.limit === 'number' && !Number.isNaN(options.limit)
    ? Math.max(0, options.limit)
    : Infinity;
  const maxBytes = options.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const skipProfileImages = options.skipProfileImages ?? false;
  const r2Config = options.uploadR2 ? resolveR2Config() : null;
  const deleteLocalAfterUpload = Boolean(r2Config && options.deleteLocalAfterUpload);
  const mediaDir = bookmarkMediaDir();
  const manifestPath = bookmarkMediaManifestPath();
  await ensureDir(mediaDir);

  const previous = await loadManifest();
  const coveredAssetKeys = buildCoveredAssetKeys(previous, maxBytes, Boolean(r2Config));
  const coveredProfileImageUrls = buildCoveredProfileImageUrls(previous, maxBytes, Boolean(r2Config));
  const bookmarks = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
  const candidates = bookmarks
    .filter(hasMediaCandidate)
    .filter((bookmark) => hasPendingMediaTarget(bookmark, coveredAssetKeys, coveredProfileImageUrls, skipProfileImages))
    .slice(0, limit);
  const entriesByKey = new Map((previous?.entries ?? []).map((entry) => [mediaEntryKeyFromEntry(entry), entry]));
  const cachedResultsBySourceUrl = new Map<string, CachedMediaResult>();

  const existingFiles = await readdir(mediaDir);
  const existingDigestIndex = new Map<string, string>();
  for (const name of existingFiles) {
    const dashIdx = name.indexOf('-');
    const dotIdx = name.lastIndexOf('.');
    if (dashIdx !== -1 && dotIdx > dashIdx) {
      existingDigestIndex.set(name.slice(dashIdx + 1), path.join(mediaDir, name));
    } else if (dotIdx !== -1) {
      existingDigestIndex.set(name, path.join(mediaDir, name));
    }
  }

  let downloaded = 0;
  let uploaded = 0;
  let deletedLocal = 0;
  let skippedTooLarge = 0;
  let failed = 0;
  let processed = 0;

  const emitProgress = (currentSourceUrl?: string) => {
    options.onProgress?.({
      candidateBookmarks: candidates.length,
      processed,
      downloaded,
      uploaded,
      deletedLocal,
      skippedTooLarge,
      failed,
      currentSourceUrl,
    });
  };

  const upsertEntry = (entry: MediaFetchEntry): void => {
    entriesByKey.set(mediaEntryKeyFromEntry(entry), entry);
  };

  const applyCachedResult = (
    target: MediaFetchTarget,
    key: string,
    cached: CachedMediaResult,
  ): void => {
    const { bookmarkId, tweetId, tweetUrl, authorHandle, authorName, sourceUrl, isProfileImage } = target;
    if (isProfileImage) return;
    upsertEntry({
      bookmarkId,
      tweetId,
      tweetUrl,
      authorHandle,
      authorName,
      sourceUrl,
      localPath: cached.localPath,
      r2Key: cached.r2Key,
      r2Url: cached.r2Url,
      contentType: cached.contentType,
      bytes: cached.bytes,
      status: cached.status,
      reason: cached.reason,
      fetchedAt: cached.fetchedAt,
    });
    if (cached.status === 'downloaded') {
      coveredAssetKeys.add(key);
      downloaded += 1;
    } else if (cached.status === 'skipped_too_large') {
      coveredAssetKeys.add(key);
      skippedTooLarge += 1;
    } else {
      failed += 1;
    }
    processed += 1;
    emitProgress(sourceUrl);
  };

  emitProgress();

  for (const bookmark of candidates) {
    const mediaTargets = resolveMediaTargets(bookmark, coveredProfileImageUrls, skipProfileImages);

    for (const target of mediaTargets) {
      const { bookmarkId, tweetId, tweetUrl, authorHandle, authorName, sourceUrl, isProfileImage } = target;
      const key = mediaEntryKey(tweetId, sourceUrl, isProfileImage);
      if (!isProfileImage && coveredAssetKeys.has(key)) continue;
      const cachedResult = cachedResultsBySourceUrl.get(sourceUrl);
      if (cachedResult) {
        applyCachedResult(target, key, cachedResult);
        continue;
      }

      const fetchedAt = new Date().toISOString();

      try {
        const head = await fetch(sourceUrl, { method: 'HEAD' });
        const contentLengthHeader = head.headers.get('content-length');
        const contentType = head.headers.get('content-type') ?? undefined;
        const declaredBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;

        if (typeof declaredBytes === 'number' && !Number.isNaN(declaredBytes) && declaredBytes > maxBytes) {
          const entry = {
            bookmarkId,
            tweetId,
            tweetUrl,
            authorHandle,
            authorName,
            sourceUrl,
            contentType,
            bytes: declaredBytes,
            status: 'skipped_too_large',
            reason: `content-length ${declaredBytes} exceeds max ${maxBytes}`,
            fetchedAt,
          } satisfies MediaFetchEntry;
          upsertEntry(entry);
          cachedResultsBySourceUrl.set(sourceUrl, {
            contentType,
            bytes: declaredBytes,
            status: entry.status,
            reason: entry.reason,
            fetchedAt,
          });
          skippedTooLarge += 1;
          if (isProfileImage) coveredProfileImageUrls.add(sourceUrl);
          else coveredAssetKeys.add(key);
          processed += 1;
          emitProgress(sourceUrl);
          continue;
        }

        const response = await fetch(sourceUrl);
        if (!response.ok) {
          const entry = {
            bookmarkId,
            tweetId,
            tweetUrl,
            authorHandle,
            authorName,
            sourceUrl,
            status: 'failed',
            reason: `HTTP ${response.status}`,
            fetchedAt,
          } satisfies MediaFetchEntry;
          upsertEntry(entry);
          cachedResultsBySourceUrl.set(sourceUrl, {
            status: entry.status,
            reason: entry.reason,
            fetchedAt,
          });
          failed += 1;
          processed += 1;
          emitProgress(sourceUrl);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
          const entry = {
            bookmarkId,
            tweetId,
            tweetUrl,
            authorHandle,
            authorName,
            sourceUrl,
            contentType: response.headers.get('content-type') ?? contentType ?? undefined,
            bytes: buffer.byteLength,
            status: 'skipped_too_large',
            reason: `downloaded size ${buffer.byteLength} exceeds max ${maxBytes}`,
            fetchedAt,
          } satisfies MediaFetchEntry;
          upsertEntry(entry);
          cachedResultsBySourceUrl.set(sourceUrl, {
            contentType: entry.contentType,
            bytes: buffer.byteLength,
            status: entry.status,
            reason: entry.reason,
            fetchedAt,
          });
          skippedTooLarge += 1;
          if (isProfileImage) coveredProfileImageUrls.add(sourceUrl);
          else coveredAssetKeys.add(key);
          processed += 1;
          emitProgress(sourceUrl);
          continue;
        }

        const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
        const ext = sanitizeExtFromContentType(response.headers.get('content-type') ?? contentType ?? undefined, sourceUrl);
        const digestKey = `${digest}${ext}`;
        const existingPath = existingDigestIndex.get(digestKey);
        const filename = isProfileImage
          ? digestKey
          : `${tweetId}-${digestKey}`;
        const localPath = existingPath ?? path.join(mediaDir, filename);
        if (!existingPath) {
          await writeFile(localPath, buffer);
          existingDigestIndex.set(digestKey, localPath);
        }
        let finalLocalPath: string | undefined = localPath;
        let r2Key: string | undefined;
        let r2Url: string | undefined;
        if (r2Config) {
          r2Key = `${r2Config.prefix}/${filename}`;
          r2Url = await uploadToR2(r2Config, r2Key, buffer, response.headers.get('content-type') ?? contentType ?? undefined);
          uploaded += 1;
          if (deleteLocalAfterUpload) {
            await rm(localPath, { force: true });
            finalLocalPath = undefined;
            existingDigestIndex.delete(digestKey);
            deletedLocal += 1;
          }
        }
        if (isProfileImage) coveredProfileImageUrls.add(sourceUrl);
        else coveredAssetKeys.add(key);

        const entry = {
          bookmarkId,
          tweetId,
          tweetUrl,
          authorHandle,
          authorName,
          sourceUrl,
          localPath: finalLocalPath,
          r2Key,
          r2Url,
          contentType: response.headers.get('content-type') ?? contentType ?? undefined,
          bytes: buffer.byteLength,
          status: 'downloaded',
          fetchedAt,
        } satisfies MediaFetchEntry;
        upsertEntry(entry);
        cachedResultsBySourceUrl.set(sourceUrl, {
          localPath: finalLocalPath,
          r2Key,
          r2Url,
          contentType: entry.contentType,
          bytes: buffer.byteLength,
          status: entry.status,
          fetchedAt,
        });
        downloaded += 1;
        processed += 1;
        emitProgress(sourceUrl);
      } catch (error) {
        const entry = {
          bookmarkId,
          tweetId,
          tweetUrl,
          authorHandle,
          authorName,
          sourceUrl,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          fetchedAt,
        } satisfies MediaFetchEntry;
        upsertEntry(entry);
        cachedResultsBySourceUrl.set(sourceUrl, {
          status: entry.status,
          reason: entry.reason,
          fetchedAt,
        });
        failed += 1;
        processed += 1;
        emitProgress(sourceUrl);
      }
    }
  }

  const manifestLimit = Number.isFinite(limit) ? limit : candidates.length;
  const manifest: MediaFetchManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    limit: manifestLimit,
    maxBytes,
    processed,
    downloaded,
    uploaded,
    deletedLocal,
    skippedTooLarge,
    failed,
    entries: Array.from(entriesByKey.values()),
  };

  await writeJson(manifestPath, manifest);
  return manifest;
}
