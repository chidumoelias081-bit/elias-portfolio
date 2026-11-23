const express = require('express'), cors = require('cors'), jwt = require('jsonwebtoken'),
  multer = require('multer'), rate = require('express-rate-limit'), { Pool } = require('pg'),
  cloud = require('cloudinary').v2; // reads CLOUDINARY_URL automatically
const { DATABASE_URL, ADMIN_PASSWORD, JWT_SECRET, FRONTEND_URL = '*', PORT = 3000 } = process.env;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL || '') ? false : { rejectUnauthorized: false } }); // Aiven needs SSL
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 45 * 1024 * 1024 } });
const app = express();
app.use(cors({ origin: FRONTEND_URL })); app.use(express.json({ limit: '200kb' }));
const wrap = f => (q, s, n) => f(q, s, n).catch(e => { console.error(e); s.status(500).json({ error: 'Server error' }); });
const admin = (q, s, n) => { try { jwt.verify((q.headers.authorization || '').slice(7), JWT_SECRET); n(); } catch { s.status(401).json({ error: 'Not authorised' }); } };
const limit = rate({ windowMs: 60000, max: 15 });
const q = (t, p) => pool.query(t, p).then(r => r.rows);

app.post('/api/login', rate({ windowMs: 900000, max: 10 }), (req, res) =>
  req.body.password && req.body.password === ADMIN_PASSWORD
    ? res.json({ token: jwt.sign({ a: 1 }, JWT_SECRET, { expiresIn: '7d' }) })
    : res.status(401).json({ error: 'Wrong password' }));

app.get('/api/profile', wrap(async (_, res) => res.json((await q('select data from profile where id=1'))[0].data)));
app.put('/api/profile', admin, wrap(async (req, res) => { await q('update profile set data=$1 where id=1', [req.body]); res.json({ ok: 1 }); }));

app.get('/api/projects', wrap(async (_, res) => res.json(await q('select id,data from projects order by id desc'))));
app.post('/api/projects', admin, wrap(async (req, res) => res.json((await q('insert into projects(data) values($1) returning id', [req.body]))[0])));
app.delete('/api/projects/:id', admin, wrap(async (req, res) => { await q('delete from projects where id=$1', [req.params.id]); res.json({ ok: 1 }); }));

app.get('/api/posts', wrap(async (_, res) => res.json(await q(`
  select p.*,
   coalesce((select json_object_agg(kind,c) from (select kind,count(*) c from reactions where post_id=p.id group by kind) r),'{}') reactions,
   coalesce((select json_agg(json_build_object('id',c.id,'name',c.name,'body',c.body,'created',c.created) order by c.created) from comments c where c.post_id=p.id),'[]') comments
  from posts p order by created desc limit 50`))));

const OKTYPE = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/;
const embed = u => { u = (u || '').trim(); let m;
  if ((m = u.match(/^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/))) return 'https://www.youtube.com/embed/' + m[1];
  if ((m = u.match(/^https:\/\/(?:www\.)?vimeo\.com\/(\d+)/))) return 'https://player.vimeo.com/video/' + m[1];
  return null; };
app.post('/api/posts', admin, upload.single('media'), wrap(async (req, res) => {
  const text = (req.body.body || '').trim().slice(0, 5000); let url = null, type = null;
  if (req.file) {
    if (!OKTYPE.test(req.file.mimetype)) return res.status(400).json({ error: 'Unsupported file type' });
    type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    if (process.env.CLOUDINARY_URL) url = await new Promise((ok, no) => cloud.uploader.upload_stream({ resource_type: 'auto', folder: 'portfolio' }, (e, r) => e ? no(e) : ok(r.secure_url)).end(req.file.buffer));
    else url = '/api/media/' + (await q('insert into media(mime,data) values($1,$2) returning id', [req.file.mimetype, req.file.buffer]))[0].id;
  } else if ((req.body.embed || '').trim()) {
    url = embed(req.body.embed); type = 'embed';
    if (!url) return res.status(400).json({ error: 'Use a YouTube or Vimeo link' });
  }
  if (!url && !text) return res.status(400).json({ error: 'Write something or add a photo or video' });
  res.json((await q('insert into posts(body,media_url,media_type) values($1,$2,$3) returning id', [text, url, type]))[0]);
}));
app.get('/api/media/:id', wrap(async (req, res) => {
  const id = +req.params.id || 0, m = (await q('select mime, octet_length(data) len from media where id=$1', [id]))[0];
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!r) { res.set('Content-Length', m.len); return res.end((await q('select data from media where id=$1', [id]))[0].data); }
  const s = r[1] === '' ? Math.max(0, m.len - +r[2]) : +r[1];
  const e = Math.min(r[1] === '' || r[2] === '' ? m.len - 1 : +r[2], s + 2 * 1024 * 1024 - 1, m.len - 1);
  if (s > e) return res.status(416).set('Content-Range', 'bytes */' + m.len).end();
  const d = (await q('select substring(data from $2 for $3) as d from media where id=$1', [id, s + 1, e - s + 1]))[0].d;
  res.status(206).set({ 'Content-Range': `bytes ${s}-${e}/${m.len}`, 'Content-Length': d.length }).end(d);
}));
app.delete('/api/posts/:id', admin, wrap(async (req, res) => {
  const p = (await q('delete from posts where id=$1 returning media_url', [req.params.id]))[0];
  const m = /^\/api\/media\/(\d+)$/.exec((p && p.media_url) || ''); if (m) await q('delete from media where id=$1', [m[1]]);
  res.json({ ok: 1 }); }));

app.post('/api/posts/:id/react', limit, wrap(async (req, res) => {
  const { visitor, kind } = req.body, id = +req.params.id;
  if (!visitor || !['like', 'love', 'insightful'].includes(kind)) return res.status(400).json({ error: 'Bad reaction' });
  const old = (await q('select kind from reactions where post_id=$1 and visitor=$2', [id, visitor]))[0];
  if (old && old.kind === kind) await q('delete from reactions where post_id=$1 and visitor=$2', [id, visitor]); // click again = undo
  else await q('insert into reactions values($1,$2,$3) on conflict (post_id,visitor) do update set kind=$3', [id, visitor, kind]);
  res.json({ ok: 1 });
}));
app.post('/api/posts/:id/comments', limit, wrap(async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60), body = (req.body.body || '').trim().slice(0, 1000);
  if (!name || !body) return res.status(400).json({ error: 'Name and comment required' });
  await q('insert into comments(post_id,name,body) values($1,$2,$3)', [req.params.id, name, body]); res.json({ ok: 1 });
}));
app.delete('/api/comments/:id', admin, wrap(async (req, res) => { await q('delete from comments where id=$1', [req.params.id]); res.json({ ok: 1 }); }));

app.post('/api/messages', limit, wrap(async (req, res) => {
  const b = req.body || {}; if (b.website) return res.json({ ok: 1 }); // honeypot
  const name = (b.name || '').trim().slice(0, 80), email = (b.email || '').trim().slice(0, 120), body = (b.body || '').trim().slice(0, 3000);
  if (!name || !body || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please give your name, a valid email and a message' });
  await q('insert into messages(name,email,body) values($1,$2,$3)', [name, email, body]); res.json({ ok: 1 });
}));
app.get('/api/messages', admin, wrap(async (_, res) => res.json(await q('select * from messages order by created desc limit 200'))));
app.delete('/api/messages/:id', admin, wrap(async (req, res) => { await q('delete from messages where id=$1', [req.params.id]); res.json({ ok: 1 }); }));
app.use((e, _q, res, _n) => res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 45 MB)' : 'Server error' }));
app.get('/', (_, res) => res.send('Portfolio API running'));
q(`create table if not exists profile(id int primary key default 1, data jsonb not null default '{}');
   create table if not exists projects(id serial primary key, data jsonb not null);
   create table if not exists posts(id serial primary key, body text, media_url text, media_type text, created timestamptz default now());
   create table if not exists comments(id serial primary key, post_id int references posts(id) on delete cascade, name text, body text, created timestamptz default now());
   create table if not exists reactions(post_id int references posts(id) on delete cascade, visitor text, kind text, primary key(post_id,visitor));
   create table if not exists media(id serial primary key, mime text, data bytea, created timestamptz default now());
   alter table media alter column data set storage external;
   create table if not exists messages(id serial primary key, name text, email text, body text, created timestamptz default now());
   insert into profile(id) values(1) on conflict do nothing;`)
  .then(() => app.listen(PORT, () => console.log('API on', PORT))).catch(e => { console.error(e); process.exit(1); });
