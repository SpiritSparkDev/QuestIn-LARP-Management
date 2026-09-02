import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { router } from '../routes.js';
import { requireAuth } from '../middleware/authenticate.js';
import { readJsonBody } from '../httpBody.js';
import { getCharacter } from '../characters/repository.js';
import { getAppSettings } from '../appSettings/repository.js';
import {
  createCharacterFile,
  getCharacterFile,
  listCharacterFiles,
  getCharacterFilesTotalSize,
  deleteCharacterFile,
} from './repository.js';

const UPLOADS_DIR = process.env.UPLOADS_DIR || './uploads';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// A 20MB file base64-encodes to exactly ~26.7MB, before the surrounding
// JSON envelope (field names, other short fields) adds a bit more -- 30MB
// leaves real headroom above that, not just up to the encoded size alone,
// so the *intended* 413 (file too large) is what a too-big upload actually
// hits, rather than an earlier, less specific 400 from readJsonBody's own
// raw-body-size cap firing first.
const MAX_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const MIME_ALLOWLIST = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: ['application/pdf'],
};

function canManage(character, user) {
  return character.user_id === user.id || user.group.canOverrideCheckinStatus;
}

function canView(file, character, user) {
  return file.is_public || canManage(character, user);
}

router.post('/characters/:id/files', requireAuth(async ({ req, params, user }) => {
  const character = await getCharacter(params.id);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  if (!canManage(character, user)) return { status: 403, body: { error: 'forbidden' } };

  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  if (body === null) return { status: 400, body: { error: 'invalid JSON' } };
  const { kind, filename, mimeType, dataBase64, isPublic, gdprConsent } = body;

  if (gdprConsent !== true) return { status: 400, body: { error: 'gdprConsent must be true' } };
  if (!MIME_ALLOWLIST[kind]?.includes(mimeType)) {
    return { status: 400, body: { error: `mimeType must be one of: ${Object.values(MIME_ALLOWLIST).flat().join(', ')}, matching kind "${kind}"` } };
  }
  if (typeof filename !== 'string' || !filename) {
    return { status: 400, body: { error: 'filename is required' } };
  }
  // Buffer.from ignores the 'base64' encoding argument for an array-like
  // object (e.g. {length: 4_000_000_000}) and instead allocates a
  // zero-filled buffer of that length -- an unauthenticated-size request
  // body can force a multi-second, memory-exhausting allocation this way.
  if (typeof dataBase64 !== 'string') {
    return { status: 400, body: { error: 'dataBase64 must be a base64 string' } };
  }

  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    return { status: 400, body: { error: 'dataBase64 is not valid base64' } };
  }
  if (buffer.length === 0) return { status: 400, body: { error: 'dataBase64 is required' } };
  if (buffer.length > MAX_FILE_BYTES) {
    return { status: 413, body: { error: `file exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB per-file limit` } };
  }

  const settings = await getAppSettings();
  const quotaBytes = settings.quotaMbPerCharacter * 1024 * 1024;
  const currentTotal = await getCharacterFilesTotalSize(character.id);
  if (currentTotal + buffer.length > quotaBytes) {
    return { status: 413, body: { error: 'this character has reached its storage quota' } };
  }

  const id = crypto.randomUUID();
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, id), buffer);

  const file = await createCharacterFile({
    id,
    characterId: character.id,
    uploadedBy: user.id,
    kind,
    originalFilename: filename,
    mimeType,
    sizeBytes: buffer.length,
    isPublic: isPublic === true,
  });
  return { status: 201, body: file };
}));

router.get('/characters/:characterId/files', requireAuth(async ({ params, user }) => {
  const character = await getCharacter(params.characterId);
  if (!character) return { status: 404, body: { error: 'character not found' } };
  const files = await listCharacterFiles(character.id);
  const visible = canManage(character, user) ? files : files.filter((f) => f.is_public);
  return { status: 200, body: visible };
}));

router.get('/characters/:characterId/files/:fileId', requireAuth(async ({ params, user }) => {
  const file = await getCharacterFile(params.fileId);
  if (!file || file.character_id !== params.characterId) return { status: 404, body: { error: 'not found' } };
  const character = await getCharacter(file.character_id);
  if (!character || !canView(file, character, user)) return { status: 404, body: { error: 'not found' } };

  let data;
  try {
    data = await fs.readFile(path.join(UPLOADS_DIR, file.id));
  } catch {
    return { status: 404, body: { error: 'not found' } };
  }

  const safeFilename = file.original_filename.replace(/["\r\n]/g, '');
  return {
    status: 200,
    isBinary: true,
    body: data,
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      // mime_type is only ever the client's claimed type, never verified
      // against the actual bytes -- this stops a browser from ignoring it
      // and guessing a more "interesting" type (e.g. HTML) to render.
      'X-Content-Type-Options': 'nosniff',
    },
  };
}));

router.delete('/characters/:characterId/files/:fileId', requireAuth(async ({ params, user }) => {
  const file = await getCharacterFile(params.fileId);
  if (!file || file.character_id !== params.characterId) return { status: 404, body: { error: 'not found' } };
  const character = await getCharacter(file.character_id);
  if (!character || !canManage(character, user)) return { status: 403, body: { error: 'forbidden' } };

  await deleteCharacterFile(file.id);
  try {
    await fs.unlink(path.join(UPLOADS_DIR, file.id));
  } catch {
    // File already gone from disk (or never wrote successfully) -- the DB
    // row is already deleted, which is what actually controls reachability,
    // so this is not an error condition worth surfacing.
  }
  return { status: 200, body: { deleted: true } };
}));
