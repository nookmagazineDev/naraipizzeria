---
name: office-deploy
description: How the office website (this repo) is deployed and updated. It is NOT on Vercel anymore; it runs on the office Windows machine as the NSSM services NaraiOfficeWeb (Next.js site) and NaraiAPI (host-server). Use whenever a change needs deploying, when telling the user how to make a change go live, when "Vercel" shows up (a GitHub status, an env var, a code comment), or when deciding which update script the user must run after a merge.
---

# Deploying the office website (naraipizzeria)

## The site is not on Vercel anymore

The office website runs on the office Windows machine. It is no longer deployed on Vercel.

- The GitHub commit status `Vercel — "Account is blocked"` on PRs is left over from the old setup.
  It does not mean the build failed, and it does not block anything. Do not tell the user to fix
  their Vercel account, and do not treat it as red CI. Check the build yourself with `npx next build`.
- Many code comments, docs and error messages still say "Vercel" (e.g. "ตั้ง env บน Vercel",
  "ฝั่ง Vercel ที่ต่อ SQL ตรง"). Read them as **"the Next.js site (NaraiOfficeWeb)"**.
  Env vars that used to live on Vercel now live on the office machine, in the environment of the
  NaraiOfficeWeb service.
- Merging to `main` does **not** put anything live. Nothing deploys on its own.
  Someone has to run an update script on the office machine.

## Two services, two update scripts

Both run from a clone of this repo on the office machine. Both need **Run as administrator**,
and both use NSSM (`C:\tools\nssm.exe`).

| What changed in the merge | Service | Script the user runs | What the script does |
|---|---|---|---|
| `pages/`, `components/`, `lib/`, `styles/`, `package.json` (anything the website uses) | `NaraiOfficeWeb` (Next.js) | `update-office.bat` | git pull → `npm ci` if packages changed → `npm run build` → restart. Build fails = rolls back by itself. Site is down about 1–3 min. |
| `host-server/` **or** `lib/` files that host-server loads (e.g. `lib/branchSql.mjs`, `lib/sheetsSql.mjs`, `lib/*Sql.mjs`) | `NaraiAPI` (host-server, port 14365) | `update-api.bat` | git pull → `npm install` in host-server if its package.json changed → restart → checks `/sheets/ping`. Data pages fail for about 5–10 s. |

`update-office.bat` does **not** restart NaraiAPI. It only prints a note when `host-server/` changed.
So a PR that adds a new `/sheets/*` endpoint and a page that calls it needs **both** scripts.
Run `update-api.bat` first, then `update-office.bat`, so the page never calls an endpoint that isn't there yet.

`lib/*Sql.mjs` files are shared: the website imports them for direct SQL, and host-server imports
them (dynamic `import('../lib/...')`) for the host API route. A change to one of them usually
needs both scripts.

## What to tell the user after a merge

List exactly which scripts to run, in order, based on the files the PR touched. For example:

> merge แล้ว ยังไม่ขึ้นเว็บจริงจนกว่าจะรันที่เครื่องออฟฟิศ (คลิกขวา → Run as administrator):
> 1. `update-api.bat` — เพราะแก้ host-server / lib ที่ host-server ใช้
> 2. `update-office.bat` — เพราะแก้หน้าเว็บ

If a script stops with "มีไฟล์ถูกแก้ค้างอยู่บนเครื่องนี้", someone edited files on the office machine.
Ask the user to send the file list before doing anything else. Don't tell them to `git reset`.

## Before pushing

- `npx next build` must pass. The office machine runs the same build, and a failure there rolls back
  the update.
- `package-lock.json` must match `package.json`. `update-office.bat` runs `npm ci` when packages
  change, and `npm ci` refuses a lockfile that is out of sync. (As of 2026-11 the lockfile was
  missing `mssql@11.0.3`.) If `npm ci` fails locally, install with
  `npm install --no-save --package-lock=false` just to build, and tell the user the lockfile needs fixing.
- host-server is CommonJS: check it with `node --check host-server/<file>.js`.
