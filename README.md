# Portfolio (Netlify + Render + Aiven)
Structure: `web/` static site (Netlify) · `server/` API (Render) · Aiven PostgreSQL · Cloudinary (photo/video storage).

1. **Aiven**: create a PostgreSQL service, copy its *Service URI* -> `DATABASE_URL`.
2. **Cloudinary** (free): copy the API environment variable -> `CLOUDINARY_URL` (cloudinary://key:secret@cloudname). Render's disk is temporary, so media must live here.
3. **Render**: New Web Service from your GitHub repo. Root directory `server`, build `npm install`, start `node server.js`. Environment variables:
   `DATABASE_URL`, `CLOUDINARY_URL`, `ADMIN_PASSWORD` (choose a strong one), `JWT_SECRET` (long random string), `FRONTEND_URL` (your Netlify URL, no trailing slash).
4. Edit `web/config.js`: set `API_URL` to your Render URL, commit.
5. **Netlify**: new site from the same repo, publish directory `web`, no build command.
6. Open your site, click **Admin** in the footer, log in, and fill in your profile, projects and posts.
Local test: `cd server && npm install && DATABASE_URL=... ADMIN_PASSWORD=x JWT_SECRET=y node server.js`, then open `web/index.html`.
