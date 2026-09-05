# Steps & sleep dashboard (Netlify)

Pulls your daily steps and sleep from your Xiaomi Mi Fitness account and
publishes a small trend dashboard you can share with your health coach.
Runs entirely on Netlify: a scheduled function pulls the data every
morning, Netlify Blobs stores it, and the dashboard reads it live.

**Before you start:** this uses the same private endpoints the Mi Fitness
app itself calls, not an official Xiaomi API (Xiaomi doesn't offer one to
individuals). It's reverse-engineered from public write-ups by other
developers, works with your own account, and only pulls your own data —
but it sits outside Xiaomi's terms of service and could break if they
change their backend. Treat it as a personal convenience project, not
something to depend on for anything critical.

**Why this uses a captured token instead of your login:** an earlier
version of this had the scheduled job log in fresh with your email and
password each day. Xiaomi's fraud detection flags repeated logins from
an unfamiliar server as suspicious and demands email verification —
which a scheduled job can't complete on its own. Reusing a real session
token captured once from your own phone avoids triggering that check at
all, the same way your phone's Mi Fitness app stays logged in without
re-verifying every sync.

**Two ways to get data in:** you can start using the dashboard right away
with a manual import (via `/upload.html`) from Xiaomi's own data export,
and switch on the automated daily pull later whenever the token capture
is sorted — they share the same storage, so nothing gets lost when you
switch. See "Getting your first data in" below.

## One-time setup (about 15-20 minutes without automation, +10-15 min if adding it now)

### 1. Push this folder to a git repo (GitHub, GitLab, or Bitbucket)
Scheduled Functions and Blobs need a git-connected Netlify site rather
than a drag-and-drop deploy, since Netlify needs to install the
`@netlify/blobs` dependency at build time.

### 2. Create a new site on Netlify from that repo
- New site from Git → pick the repo
- Build command: leave blank
- Publish directory: `.`
- Deploy

### 3. Add a site password as environment variables
This is separate from Mi Fitness credentials — it's just what protects
your dashboard from being publicly viewable.

- Site settings → Environment variables → Add a variable
  - `SITE_USERNAME` — a username for the dashboard itself (anything you like)
  - `SITE_PASSWORD` — a password for the dashboard (share this with your coach)
- Redeploy the site after adding these (Deploys → Trigger deploy)

The site is hosted at a public Netlify URL, but every page (including the
data endpoint) is gated behind that username/password via an Edge
Function — nobody without the credentials can see anything, even if they
find the link. Give your coach the URL plus the `SITE_USERNAME` /
`SITE_PASSWORD` you set, and their browser will prompt them once and
remember it.

## Getting your first data in (manual import)

You don't need the automated token capture to start using the dashboard.

1. Go to [account.xiaomi.com](https://account.xiaomi.com) → Privacy →
   Manage, and request a data export for your account.
2. Once it arrives, open it and find your daily steps and sleep figures.
   Xiaomi's export format varies, so you may need to reshape it into a
   simple CSV with these columns (only `date` and `steps` are required):
   ```
   date,steps,sleep_total_min,sleep_deep_min,sleep_light_min,distance_m,calories
   2026-08-25,8423,412,95,317,,
   ```
   If you're not sure how to turn what Xiaomi gives you into this shape,
   send me a sample of the export and I'll help convert it.
3. Visit `your-site-url/upload.html`, choose the CSV file, and click
   Import. Re-uploading later (e.g. with more days) is safe — matching
   dates get overwritten, everything else is kept.
4. Visit the dashboard itself — it should now show your imported history.

## Turning on automated daily pulls (later)

Once you have `ssecurity`, `cUserId`, `serviceToken`, and `phone_id` (see
[`docs/capture-token.md`](docs/capture-token.md)):

1. Add environment variables `MIFIT_SSECURITY`, `MIFIT_CUSERID`,
   `MIFIT_SERVICETOKEN`, and `MIFIT_PHONE_ID` in Netlify site settings,
   and redeploy.
2. Go to the **Functions** tab → `pull-data` → trigger it manually once,
   and check the logs for "Pulled N entries, M days total".
3. From then on it runs automatically every day at 06:15 UTC (edit the
   `schedule` value in `netlify/functions/pull-data.mjs` to change the
   time). It merges on top of whatever you've already imported manually
   — no duplication, nothing lost. The first run pulls your entire
   history; every run after that only pulls what's new, using a stored
   pagination cursor.

**Being honest about reliability:** in testing, captured sessions have
sometimes stopped working within hours rather than days or weeks — we
don't have a confirmed lifespan for these credentials. If the daily
pull starts failing, it's not necessarily a bug; it may just mean this
particular session expired and needs recapturing. Given that, treat
the manual CSV import as the reliable fallback, not a stopgap — if the
automated pull turns out to need recapturing as often as every few
days, doing a manual export/import on that same cadence is genuinely
less work.

## If the pull starts failing

Check the `pull-data` function logs first:

- **A `401` or `auth err`** → the session has expired. Redo the capture
  in `docs/capture-token.md` and update the four `MIFIT_*` environment
  variables — the dashboard and existing history aren't affected, this
  only refreshes how new days get pulled in.
- **Anything else** → Xiaomi may have changed something about these
  endpoints. Paste the exact error back and it can be debugged from
  there.
