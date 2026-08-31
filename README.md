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

## One-time setup (about 10-15 minutes)

### 1. Push this folder to a git repo (GitHub, GitLab, or Bitbucket)
Scheduled Functions and Blobs need a git-connected Netlify site rather
than a drag-and-drop deploy, since Netlify needs to install the
`@netlify/blobs` dependency at build time. If you don't already have a
git provider set up, GitHub's free tier works fine — you're just using it
to hold the code, not to run anything.

### 2. Create a new site on Netlify from that repo
- New site from Git → pick the repo
- Build command: leave blank
- Publish directory: `.`
- Deploy

### 3. Add your Mi Fitness login and a site password as environment variables
None of these ever appear in the code — they're read from Netlify's
encrypted environment variables at run time.

- Site settings → Environment variables → Add a variable
  - `MIFIT_EMAIL` — the email you sign into Mi Fitness with
  - `MIFIT_PASSWORD` — your Mi Fitness password
  - `SITE_USERNAME` — a username for the dashboard itself (anything you like)
  - `SITE_PASSWORD` — a password for the dashboard (share this with your coach)
- Redeploy the site after adding these (Deploys → Trigger deploy)

The site is hosted at a public Netlify URL, but every page (including the
data endpoint) is gated behind that username/password via an Edge
Function — nobody without the credentials can see anything, even if they
find the link. Give your coach the URL plus the `SITE_USERNAME` /
`SITE_PASSWORD` you set, and their browser will prompt them once and
remember it.

If your Xiaomi account only has phone-number sign-in (no email), this
login flow won't work as-is and needs a small adjustment — let me know
and I'll add that path.

### 4. Run the pull once manually
- Go to the **Functions** tab in your Netlify site
- Open `pull-data`
- Trigger it manually (Netlify lets you invoke scheduled functions on
  demand from this tab)
- Check the logs for "Stored N days total"

### 5. Visit your site
Your dashboard is live at your Netlify URL (or a custom domain if you set
one up) — that's the link you send your coach. It updates itself every
day at 06:15 UTC (edit the `schedule` value in
`netlify/functions/pull-data.mjs` to change the time).

## If the login step fails

Xiaomi occasionally tweaks these endpoints. If the function logs show a
login error, paste it back to me and I'll help adjust the script.
