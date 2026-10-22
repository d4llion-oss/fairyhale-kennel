'use strict';
// Animal photos: upload (max 5 per animal), serve, reorder, caption, delete.
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin } = require('../lib/auth');
const { clean } = require('../lib/helpers');
const csrf = require('../lib/csrf');

const MAX_PHOTOS = 5;
const MAX_UPLOAD = 12 * 1024 * 1024; // 12 MB raw (phones), resized on arrival
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: MAX_PHOTOS },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.has(file.mimetype)),
});

const router = express.Router({ mergeParams: true });
router.use(requireLogin);
router.param('pid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).end()));

async function loadAnimal(id) {
  const { rows } = await db.query('SELECT id, name, is_active FROM animals WHERE id=$1', [id]);
  return rows[0];
}

/** Serve an image. ?size=thumb for the 320px version. Session-protected like the rest of the app. */
router.get('/:pid', async (req, res, next) => {
  try {
    const col = req.query.size === 'thumb' ? 'thumb' : 'data';
    const { rows } = await db.query(`SELECT ${col} AS img, content_type, created_at FROM animal_photos WHERE id=$1 AND animal_id=$2`, [req.params.pid, req.params.id]);
    if (!rows[0]) return res.status(404).end();
    res.setHeader('Content-Type', rows[0].content_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Last-Modified', new Date(rows[0].created_at).toUTCString());
    res.send(rows[0].img);
  } catch (e) { next(e); }
});

/** Upload one or more photos (multipart field "photos"). */
router.post('/', (req, res, next) => {
  upload.array('photos', MAX_PHOTOS)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      req.session.flash = { type: 'error', text: err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 12 MB.' : `Upload rejected (${err.code}).` };
      return res.redirect(`/animals/${req.params.id}`);
    }
    if (err) return next(err);
    if (!csrf.validateRequest(req)) {
      return res.status(403).render('error', { title: 'Form expired', status: 403, message: 'The form token was invalid or expired. Go back and try again.' });
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const files = req.files || [];
    if (!files.length) {
      req.session.flash = { type: 'error', text: 'Choose at least one JPEG, PNG, WebP or HEIC image.' };
      return res.redirect(`/animals/${animal.id}`);
    }

    const added = [];
    let skipped = 0;
    await db.withTransaction(async (c) => {
      // Lock the animal row so concurrent uploads can't both grab slot 5.
      await c.query('SELECT 1 FROM animals WHERE id=$1 FOR UPDATE', [animal.id]);
      const { rows: used } = await c.query('SELECT position FROM animal_photos WHERE animal_id=$1', [animal.id]);
      const taken = new Set(used.map((r) => r.position));
      for (const file of files) {
        let slot = null;
        for (let p = 1; p <= MAX_PHOTOS; p++) if (!taken.has(p)) { slot = p; break; }
        if (!slot) { skipped += 1; continue; }
        let full, thumb, meta;
        try {
          const base = sharp(file.buffer, { failOn: 'none' }).rotate(); // honour EXIF orientation
          full = await base.clone().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
          thumb = await base.clone().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
          meta = full.info;
        } catch (e) {
          skipped += 1; continue; // not a decodable image
        }
        const { rows } = await c.query(
          `INSERT INTO animal_photos (animal_id, position, content_type, data, thumb, thumb_fit, width, height, bytes, created_by)
           VALUES ($1,$2,'image/jpeg',$3,$4,'inside',$5,$6,$7,$8) RETURNING id, position`,
          [animal.id, slot, full.data, thumb, meta.width, meta.height, full.data.length, req.session.user.id]
        );
        taken.add(slot);
        added.push(rows[0]);
        await audit(req, { action: 'photo_add', entityType: 'animal', entityId: animal.id, summary: `Added photo #${slot} to ${animal.name} (${file.originalname}, ${Math.round(full.data.length / 1024)} KB)`, after: { photo_id: rows[0].id, position: slot, width: meta.width, height: meta.height } }, c);
      }
    });

    const parts = [];
    if (added.length) parts.push(`Added ${added.length} photo${added.length === 1 ? '' : 's'}.`);
    if (skipped) parts.push(`${skipped} skipped (limit is ${MAX_PHOTOS} per animal, or file was not a readable image).`);
    req.session.flash = { type: added.length ? 'success' : 'error', text: parts.join(' ') };
    res.redirect(`/animals/${animal.id}`);
  } catch (e) { next(e); }
});

/** Make a photo the primary (position 1); shifts the others down. */
router.post('/:pid/primary', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.redirect('/animals');
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('SELECT id, position FROM animal_photos WHERE animal_id=$1 ORDER BY position', [animal.id]);
      const target = rows.find((r) => r.id === req.params.pid);
      if (!target || target.position === 1) return;
      const order = [target, ...rows.filter((r) => r.id !== target.id)];
      // UNIQUE (animal_id, position) is deferred, so renumbering within the transaction is safe.
      for (let i = 0; i < order.length; i++) await c.query('UPDATE animal_photos SET position=$1 WHERE id=$2', [i + 1, order[i].id]);
      await audit(req, { action: 'photo_reorder', entityType: 'animal', entityId: animal.id, summary: `Set a new primary photo for ${animal.name}`, after: { photo_id: target.id } }, c);
    });
    res.redirect(`/animals/${animal.id}`);
  } catch (e) { next(e); }
});

router.post('/:pid/caption', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.redirect('/animals');
    const caption = clean(req.body.caption);
    const { rowCount } = await db.query('UPDATE animal_photos SET caption=$1 WHERE id=$2 AND animal_id=$3', [caption ? caption.slice(0, 140) : null, req.params.pid, animal.id]);
    if (rowCount) await audit(req, { action: 'photo_caption', entityType: 'animal', entityId: animal.id, summary: `Updated a photo caption for ${animal.name}`, after: { photo_id: req.params.pid, caption } });
    res.redirect(`/animals/${animal.id}`);
  } catch (e) { next(e); }
});

router.post('/:pid/delete', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.redirect('/animals');
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('DELETE FROM animal_photos WHERE id=$1 AND animal_id=$2 RETURNING position, bytes', [req.params.pid, animal.id]);
      if (!rows[0]) return;
      // Close the gap so new uploads fill from the end.
      const { rows: rest } = await c.query('SELECT id FROM animal_photos WHERE animal_id=$1 ORDER BY position', [animal.id]);
      for (let i = 0; i < rest.length; i++) await c.query('UPDATE animal_photos SET position=$1 WHERE id=$2', [i + 1, rest[i].id]);
      await audit(req, { action: 'photo_delete', entityType: 'animal', entityId: animal.id, summary: `Removed photo #${rows[0].position} from ${animal.name}`, before: { photo_id: req.params.pid, position: rows[0].position, bytes: rows[0].bytes } }, c);
    });
    req.session.flash = { type: 'success', text: 'Photo removed.' };
    res.redirect(`/animals/${animal.id}`);
  } catch (e) { next(e); }
});

module.exports = router;
