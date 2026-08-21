# Deploying to a DigitalOcean Droplet

**Setup:** app on a Droplet, database stays on cPanel.

A Droplet has one permanent IP address, which you whitelist once in
cPanel's Remote MySQL. That is why we use a Droplet rather than App
Platform — App Platform's outbound IP is not fixed, so a cPanel
whitelist there would eventually stop matching and the app would lose
its database connection with no obvious cause.

Follow the steps in order. Each block can be copied and pasted whole.

---

## Step 1 — Create the Droplet

In DigitalOcean: **Create → Droplets**

| Setting | Choose |
|---|---|
| Image | Ubuntu 24.04 (LTS) x64 |
| Plan | Basic → Regular → $6/mo (1 GB RAM) |
| Region | Singapore — closest to Cambodia |
| Authentication | SSH key (more secure) or password |
| Hostname | `fleet-server` |

When it finishes, copy the **public IPv4 address**. You need it in the
next step. This guide calls it `YOUR_DROPLET_IP`.

> **Note on RAM:** 1 GB is enough to run the app. Building the frontend
> is the memory-hungry part; if `npm run build` is ever killed, see
> Troubleshooting at the end.

---

## Step 2 — Whitelist the Droplet in cPanel

**Do this before anything else** — without it the app cannot reach the
database, and every later step will appear to work while the app fails.

1. Log in to cPanel
2. **Databases → Remote MySQL**
3. In *Add Access Host*, enter your `YOUR_DROPLET_IP`
4. Click **Add**

---

## Step 3 — Connect to the Droplet

From your Mac's Terminal:

```bash
ssh root@YOUR_DROPLET_IP
```

Everything from here runs **on the Droplet**, not on your Mac.

---

## Step 4 — Install the software

```bash
apt update && apt upgrade -y
apt install -y python3 python3-pip python3-venv git nginx curl rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

Check both installed:

```bash
python3 --version && node --version
```

---

## Step 5 — Create the application user

Running a web app as `root` means any flaw in it has full control of the
server. A dedicated user with no login shell limits the damage.

```bash
adduser --system --group --home /opt/fleet fleet
mkdir -p /opt/fleet/frontend
```

---

## Step 6 — Get the code

```bash
cd /opt/fleet
git clone https://github.com/Sokkhan099541111/app.git app
cd app
```

If the repo is private, git will ask for your username and Personal
Access Token.

---

## Step 7 — Install Python dependencies

```bash
python3 -m venv /opt/fleet/venv
/opt/fleet/venv/bin/pip install --upgrade pip
/opt/fleet/venv/bin/pip install -r /opt/fleet/app/requirements.txt
```

---

## Step 8 — Create the environment file

```bash
nano /opt/fleet/app/app/.env
```

Paste this, replacing the placeholders with your real cPanel values:

```
DB_HOST=192.250.235.126
DB_PORT=3306
DB_USER=mangotracking_app
DB_PASSWORD=your-cpanel-database-password
DB_NAME=mangotracking_app_hosting

DEFAULT_COMPANY_ID=1

JWT_SECRET_KEY=paste-the-generated-secret-here
JWT_EXPIRE_MINUTES=480
```

Save with **Ctrl+O**, Enter, then **Ctrl+X**.

Generate the JWT secret first with:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Then lock the file down so only the app can read it:

```bash
chown fleet:fleet /opt/fleet/app/app/.env
chmod 600 /opt/fleet/app/app/.env
```

---

## Step 9 — Test the database connection

```bash
cd /opt/fleet/app
/opt/fleet/venv/bin/python check_db.py
```

You want `RESULT: connection is working`.

If it fails at *"Testing network reachability"*, Step 2 was missed or the
IP was entered incorrectly. **Fix this before continuing** — nothing
after this point will work without it.

---

## Step 10 — Import the database tables

Skip this if you already imported them through phpMyAdmin.

In cPanel → phpMyAdmin → select `mangotracking_app_hosting` → **Import**,
and run the `.sql` files from the `app/` folder. Run these two **last**,
in this order:

1. `app/auth_rbac.sql`
2. `app/users_add_company_id.sql`

---

## Step 11 — Build the frontend

```bash
cd /opt/fleet/app/frontend
npm ci
npm run build
rsync -a --delete dist/ /opt/fleet/frontend/
chown -R fleet:fleet /opt/fleet/frontend
```

---

## Step 12 — Start the API

```bash
cp /opt/fleet/app/deploy/fleet-api.service /etc/systemd/system/
chown -R fleet:fleet /opt/fleet/app
systemctl daemon-reload
systemctl enable --now fleet-api
systemctl status fleet-api
```

You want to see **active (running)** in green. If not:

```bash
journalctl -u fleet-api -n 40 --no-pager
```

---

## Step 13 — Configure nginx

```bash
cp /opt/fleet/app/deploy/nginx.conf /etc/nginx/sites-available/fleet
nano /etc/nginx/sites-available/fleet
```

Change `server_name YOUR_DOMAIN_OR_IP;` to your domain, or to the Droplet
IP if you have no domain yet. Save and exit, then:

```bash
ln -sf /etc/nginx/sites-available/fleet /etc/nginx/sites-enabled/fleet
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

`nginx -t` must say **syntax is ok**. If it does not, re-check the file
before reloading.

---

## Step 14 — Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status
```

Note that port 8000 is deliberately **not** opened. The API listens only
on 127.0.0.1, so nothing reaches it except through nginx.

---

## Step 15 — Open the site

Visit `http://YOUR_DROPLET_IP` in a browser.

Log in with **`admin` / `Admin@12345`**, then change that password
immediately under Settings → User Management.

---

## Step 16 — HTTPS (once you have a domain)

Point your domain's DNS A record at `YOUR_DROPLET_IP`, wait for it to
propagate, then:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot edits the nginx config and renews automatically. Without HTTPS,
logins and payroll data travel in plain text — do this before real use.

---

## Updating after a code change

On your Mac:

```bash
git add .
git commit -m "describe the change"
git push
```

On the Droplet:

```bash
cd /opt/fleet/app
chmod +x deploy/update.sh    # first time only
sudo ./deploy/update.sh
```

That pulls, reinstalls dependencies, rebuilds the frontend, restarts the
API and reloads nginx.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502 Bad Gateway` | API is not running | `systemctl status fleet-api`, then `journalctl -u fleet-api -n 40` |
| Login fails, everything else loads | API cannot reach MySQL | Re-run `check_db.py`; confirm the Droplet IP is in cPanel Remote MySQL |
| Site loads but refreshing a page 404s | nginx config not applied | `nginx -t && systemctl reload nginx` |
| `npm run build` killed | Out of memory on a 1 GB Droplet | Add swap (below), or build on your Mac and upload `dist/` |
| Changes not visible after update | Browser cached `index.html` | Hard refresh (Cmd+Shift+R) |

Add swap if the build runs out of memory:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## One thing to watch: latency

Your database is in the cPanel data centre and the app is in Singapore,
so every query crosses the internet between them. Each page makes
several queries, so pages will be slower than if both were in the same
place.

If it feels sluggish once you are using it with real data, the fix is to
move the database to **DigitalOcean Managed MySQL** in the same region as
the Droplet. Worth measuring before deciding — it may be perfectly
acceptable.
