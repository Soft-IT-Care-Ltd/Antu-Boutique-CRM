# Backups, trash purge and daily alerts

PRD §4.18 / §7. Three scheduled jobs keep the system healthy. **Settings → Backups & nightly jobs** shows when each last ran and whether it worked. Anyone with `settings.manage` also sees a red banner on every page once the last good backup is **more than 48 hours old**.

| Job | What it does | How it runs |
|---|---|---|
| Backup | `pg_dump` of the database plus a tar of the uploads folder, kept 14 days, optionally copied off the server | `scripts/backup.sh`, from the server's crontab (outside the app) |
| Trash purge | Removes anything in the trash for 30 days, or archives it when history still points to it | `GET /api/cron/trash-purge` |
| Low-stock alert | One in-app notification a day to everyone with `inventory.purchase.create` | `GET /api/cron/low-stock-alert` |

The cron routes only answer `Authorization: Bearer $CRON_SECRET`.

---

## Crontab (server time = UTC)

```cron
# Nightly backup — 03:00 Dhaka
0 21 * * *   /srv/antu-crm/scripts/backup.sh >> /var/log/antu-backup.log 2>&1
# Trash purge — 03:30 Dhaka
30 21 * * *  curl -fsS -m 300 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/trash-purge >> /var/log/antu-cron.log 2>&1
# Low-stock alert — 09:00 Dhaka, before the shop opens
0 3 * * *    curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/low-stock-alert >> /var/log/antu-cron.log 2>&1
```

`CRON_SECRET` must be available to cron. Put `CRON_SECRET=...` at the top of the crontab, or source the app's `.env` inside a small wrapper script.

---

## The backup script

`scripts/backup.sh [env-file]` reads the app's `.env` by default. Settings:

| Variable | |
|---|---|
| `DIRECT_URL` | Neon's **direct** (non-pooler) connection string. `pg_dump` through the pooler is unreliable. |
| `BACKUP_DIR` | Required. For example `/var/backups/antu-crm`, on a disk other than the app's if possible. |
| `BACKUP_RETENTION_DAYS` | Default `14`. |
| `BACKUP_RCLONE_REMOTE` | Optional. For example `b2:antu-backups`. When set, each night's files are copied there and remote files older than the retention are removed. A failed copy counts as a failed backup. |
| `BACKUP_REPORT_URL` | Where to report. Defaults to `NEXTAUTH_URL`. |
| `PG_DUMP`, `PG_RESTORE` | Only needed if the default binaries are older than the server. |

**The client must be at least as new as the server.** Neon runs PostgreSQL 18, and `pg_dump` 16 refuses to dump it. The script checks the versions and fails with a clear message. On Ubuntu:

```bash
sudo apt install -y postgresql-common && sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
```

```bash
sudo apt install -y postgresql-client-18
```

Each run:

1. Dumps the database to `antu-db-<UTC stamp>.dump` (custom format, compressed) and checks it can be read back with `pg_restore --list`.
2. Archives the uploads folder to `antu-uploads-<stamp>.tar.gz`. Product photos, order reference images, invoices and receipts live there, and the database points at them.
3. Copies both off the server, if configured.
4. Deletes backups older than the retention, but **only after tonight's dump succeeded**, so a broken backup never eats the last good ones.
5. Reports the run (success or failure, with the reason) to `POST /api/cron/backup-report`.

If the app is down when the script reports, the backup is still made. Settings will just show it as missing.

The script only **reads** the database. It never restores, drops or resets anything.

---

## Restoring (a drill, then for real)

Restore **into a new, empty database**, never over the live one (CLAUDE.md rule 11). Any restore needs the owner's explicit OK first.

1. Create a new database on Neon (for example `antu_restore_check`).
2. Restore into it:

   ```bash
   pg_restore --no-owner --no-privileges --dbname "<new database's direct URL>" /var/backups/antu-crm/antu-db-<stamp>.dump
   ```

3. Spot-check it: count orders, look at yesterday's orders and payments, and open a customer.
4. Unpack the matching `antu-uploads-<stamp>.tar.gz` somewhere and point a copy of the app at both, if you want to click through it.
5. Only when the restored copy is right, and with the owner's go-ahead, does the app's `DATABASE_URL`/`DIRECT_URL` get pointed at it.

Run the drill once after go-live and then every few months. A backup nobody has restored is a hope, not a backup.

---

## The trash

- Orders, customers, products and leads go to the trash when deleted and can be restored from **System → Trash** for 30 days. Restoring needs the same permission as deleting.
- Only an order with **no money, stock or courier history** can be deleted: a LEAD that was never confirmed, or one cancelled before packing, with no payments. Anything further along is cancelled or returned instead.
- After 30 days the purge deletes a record for good (plus its photos and invoice files). The exception is a customer or product that history still points to: sales, stock movements, purchases, store credit, outfit sets or live orders. That record is **archived** instead. It leaves the trash and can't be restored, but the row stays, so the ledger, wallets and past reports never change. A customer who orders again (online or at the counter) comes back automatically with their history.
- A customer or product that is only pointed to by things *still in the trash* waits until those are purged.
- Photos deleted from an order are removed from disk 30 days later too.
- Every trash, restore, purge and archive writes an audit-log row. The purge's rows show "System" as the actor.
