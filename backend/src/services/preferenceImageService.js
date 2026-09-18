import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_PREFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

function storageRoot() {
  return path.resolve(
    process.env.USER_PREFERENCE_IMAGE_DIR || path.join(process.cwd(), 'uploads', 'user-preferences'),
  );
}

function extensionForMime(mimeType) {
  return MIME_EXTENSIONS[mimeType] || null;
}

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function validatePreferenceImage(file) {
  if (!file?.buffer || !file.mimetype) {
    return { ok: false, code: 'INVALID_IMAGE', message: 'File immagine mancante o non valido' };
  }
  if (!extensionForMime(file.mimetype)) {
    return { ok: false, code: 'UNSUPPORTED_IMAGE_TYPE', message: 'Formato non supportato: usa JPEG, PNG o WebP' };
  }
  const sizeBytes = file.size ?? file.buffer.length;
  if (sizeBytes > MAX_PREFERENCE_IMAGE_BYTES) {
    return { ok: false, code: 'IMAGE_TOO_LARGE', message: 'L’immagine supera il limite di 5 MiB' };
  }
  const detectedMime = detectImageMime(file.buffer);
  if (detectedMime !== file.mimetype) {
    return { ok: false, code: 'INVALID_IMAGE', message: 'Il contenuto non corrisponde al MIME dichiarato' };
  }
  return { ok: true, mimeType: detectedMime };
}

function safeStoragePath(storageKey) {
  if (!storageKey || path.isAbsolute(storageKey)) throw new Error('Chiave storage non valida');
  const root = storageRoot();
  const candidate = path.resolve(root, storageKey);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Chiave storage non valida');
  }
  return candidate;
}

export async function storePreferenceImage(file) {
  const validation = validatePreferenceImage(file);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.code = validation.code;
    error.status = validation.code === 'IMAGE_TOO_LARGE' ? 413 : 400;
    throw error;
  }

  const storageKey = `${randomUUID()}${extensionForMime(validation.mimeType)}`;
  const filePath = safeStoragePath(storageKey);
  await fs.mkdir(storageRoot(), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, file.buffer, { flag: 'wx', mode: 0o600 });

  return {
    storageKey,
    mimeType: validation.mimeType,
    sizeBytes: file.size ?? file.buffer.length,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  };
}

export async function removePreferenceImage(storageKey) {
  try {
    await fs.unlink(safeStoragePath(storageKey));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function readPreferenceImage(storageKey) {
  return fs.readFile(safeStoragePath(storageKey));
}

export function preferenceImageExtension(mimeType) {
  return extensionForMime(mimeType);
}

export function serializePreferenceImage(image) {
  const tags = Array.isArray(image.tags) ? image.tags : [];
  const analysisStatus = image.analysisStatus || 'metadata_only';
  return {
    id: image.id,
    conversationId: image.conversationId,
    originalName: image.originalName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    createdAt: image.createdAt,
    analysis: {
      status: analysisStatus,
      description: image.description || null,
      extractedPreferences: tags,
      usedAs: analysisStatus === 'completed' ? 'chat_context_hint' : 'metadata_only',
      fallbackReason: image.analysisReason || null,
    },
    url: `/api/chat/conversations/${encodeURIComponent(image.conversationId)}/preferences/images/${encodeURIComponent(image.id)}/content`,
  };
}
