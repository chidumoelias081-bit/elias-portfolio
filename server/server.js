process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require('express'),
  cors = require('cors'),
  jwt = require('jsonwebtoken'),
  multer = require('multer'),
  rate = require('express-rate-limit'),
  { Pool } = require('pg'),
  cloud = require('cloudinary').v2;

const { DATABASE_URL, ADMIN_PASSWORD, JWT_SECRET, FRONTEND_URL = '*', PORT = 3000 } = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
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

app.post('/api/posts', admin, upload.single('media'), wrap(async (req, res) => {
  let url = null, type = null;
  if (req.file) {
    type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    url = await new Promise((ok, no) => cloud.uploader.upload_stream({ resource_type: 'auto', folder: 'portfolio' }, (e, r) => e ? no(e) : ok(r.secure_url)).end(req.file.buffer));
  }
  if (!url && !(req.body.body || '').trim()) return res.status(400).json({ error: 'Empty post' });
  res.json((await q('insert into posts(body,media_url,media_type) values($1,$2,$3) returning id', [(req.body.body || '').slice(0, 5000), url, type]))[0]);
}));
app.delete('/api/posts/:id', admin, wrap(async (req, res) => { await q('delete from posts where id=$1', [req.params.id]); res.json({ ok: 1 }); }));

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

app.get('/', (_, res) => res.send('Portfolio API running'));
q(`create table if not exists profile(id int primary key default 1, data jsonb not null default '{}');
   create table if not exists projects(id serial primary key, data jsonb not null);
   create table if not exists posts(id serial primary key, body text, media_url text, media_type text, created timestamptz default now());
   create table if not exists comments(id serial primary key, post_id int references posts(id) on delete cascade, name text, body text, created timestamptz default now());
   create table if not exists reactions(post_id int references posts(id) on delete cascade, visitor text, kind text, primary key(post_id,visitor));
   insert into profile(id) values(1) on conflict do nothing;`)
  .then(() => app.listen(PORT, () => console.log('API on', PORT))).catch(e => { console.error(e); process.exit(1); });
