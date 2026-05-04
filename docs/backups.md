# Backups

This is the practical backup story for VOID right now.

It is not fancy. It is meant to save the project when a migration, refactor,
disk failure, or tired-human moment goes sideways.

## What Actually Matters

Critical:

- PostgreSQL
  - users, auth/session metadata, conversations, memberships, MLS metadata,
    key backups, attachment object mapping
- ScyllaDB
  - message history, edits, reactions, reaction counts
- MinIO
  - profile pictures, group pictures, encrypted chat attachment blobs

Useful but less critical:

- Valkey
  - sessions, presence, cache, rate-limit state, queue state
  - if lost, users may need to log in again and some in-flight jobs/presence
    state disappears, but chat history should not disappear

Not enough by itself:

- GitHub
  - saves code, not your database or media
- PM2 dump
  - saves process list, not app data
- MinIO encrypted blobs alone
  - useless without the database rows and encrypted message payloads that point
    at them

## Run A Backup

From the repo root:

```bash
./scripts/backup-voidapp.sh
```

Default output:

```text
~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ/
~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ.tar.gz
~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ.tar.gz.sha256
```

The script reads:

```text
VOID0000-api/.env
```

Override paths if needed:

```bash
VOIDAPP_ENV_FILE=/path/to/.env \
VOIDAPP_BACKUP_DIR=/mnt/backups/voidapp \
./scripts/backup-voidapp.sh
```

Skip a service if you are only testing one part:

```bash
VOIDAPP_BACKUP_SKIP_SCYLLA=1 ./scripts/backup-voidapp.sh
```

Available skip flags:

- `VOIDAPP_BACKUP_SKIP_POSTGRES=1`
- `VOIDAPP_BACKUP_SKIP_SCYLLA=1`
- `VOIDAPP_BACKUP_SKIP_MINIO=1`
- `VOIDAPP_BACKUP_SKIP_VALKEY=1`

## What The Script Uses

PostgreSQL:

- `pg_dump`
- output is custom-format `.dump`
- restore uses `pg_restore`

ScyllaDB:

- `cqlsh`
- exports schema plus table CSV files
- good enough for this project size right now
- not the final production-scale backup story

MinIO:

- prefers `mc mirror`
- falls back to copying local `minio-data` if `mc` is missing

Valkey:

- uses `valkey-cli` or `redis-cli`
- captures `INFO`, `CONFIG`, and an RDB stream when supported

## Install Helpful Tools

Ubuntu-ish:

```bash
sudo apt install postgresql-client redis-tools
```

For MinIO Client:

```bash
curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /tmp/mc
chmod +x /tmp/mc
sudo mv /tmp/mc /usr/local/bin/mc
```

For Scylla `cqlsh`, use the package method that matches how Scylla was
installed on your machine. If `cqlsh` works in your terminal, the backup script
can use it.

## Suggested Schedule

For a hobby public-ish server:

- before every migration or risky refactor
- daily while actively developing
- keep at least 7 daily backups
- keep a few weekly backups if disk space allows
- copy important backups off the same machine

A backup sitting on the same disk is better than nothing, but it is still not a
real disaster backup. If the disk dies, it dies with the app.

Simple cron example:

```cron
15 3 * * * cd /home/void0000/Desktop/VOIDAPP && ./scripts/backup-voidapp.sh >> /home/void0000/voidapp-backups/backup.log 2>&1
```

## Future Hot And Cold Storage

Right now this project can keep MinIO on the same machine because the data is
small. If it grows, the simple future plan is:

- Hot storage: live MinIO data on a mounted data drive, for example
  `/srv/voidapp/minio-data`.
- Cold storage: backup archives copied somewhere else, for example an external
  drive, NAS, cheap storage box, or another server.
- Keep the app reading from hot storage. Treat cold storage as disaster recovery,
  not as a place to silently move active attachment files.

Later, if the app needs true archiving, add it as an app feature: mark old files
as archived in the database, move them intentionally, and show a restore/loading
state when someone opens an old attachment. Until then, live MinIO objects should
stay where the app expects them.

## Restore Order

Do restores on a test machine first if you can. Restore drills are where the
backup stops being a theory.

There is now a helper script:

```bash
./scripts/restore-voidapp.sh --backup /path/to/backup --dry-run --all
```

That command only prints the restore steps. It does not change data.

To restore for real, choose the parts you want and pass `--yes`:

```bash
./scripts/restore-voidapp.sh \
  --backup /path/to/backup \
  --postgres \
  --scylla \
  --minio \
  --yes
```

The restore script accepts either:

- backup folder: `~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ`
- backup archive: `~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ.tar.gz`

The script intentionally does **not** restore Valkey automatically. For VOID,
Valkey is mostly sessions/cache/presence/queue state, so the safer default is
to let it rebuild unless you have a very specific reason to restore it.

Safe rough order:

1. Stop the app:

```bash
pm2 stop all
```

2. Restore PostgreSQL.

Create or empty the target database first. Be careful. This destroys/overwrites
data if pointed at the wrong DB.

```bash
pg_restore \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -d void-app \
  --clean \
  --if-exists \
  /path/to/backup/postgres/void-app.dump
```

3. Restore Scylla schema and tables.

```bash
cqlsh 127.0.0.1 9042 -f /path/to/backup/scylla/schema.cql
```

Then import each CSV:

```bash
cqlsh 127.0.0.1 9042 -e "COPY voidapp.messages FROM '/path/to/backup/scylla/messages.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.message_edits FROM '/path/to/backup/scylla/message_edits.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.message_reactions FROM '/path/to/backup/scylla/message_reactions.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.user_reactions FROM '/path/to/backup/scylla/user_reactions.csv' WITH HEADER = TRUE;"
cqlsh 127.0.0.1 9042 -e "COPY voidapp.reaction_counts FROM '/path/to/backup/scylla/reaction_counts.csv' WITH HEADER = TRUE;"
```

4. Restore MinIO.

If the backup was made with `mc mirror`:

```bash
mc alias set local http://127.0.0.1:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
mc mirror --overwrite /path/to/backup/minio/avatars local/avatars
mc mirror --overwrite /path/to/backup/minio/group-avatars local/group-avatars
mc mirror --overwrite /path/to/backup/minio/chat-attachments local/chat-attachments
```

If the backup used raw `minio-data`, restore it only while MinIO is stopped.

5. Restore Valkey only if you really need session/queue/cache state.

Most of the time, it is fine to let Valkey start fresh. Users log in again and
presence/rate-limit/cache state rebuilds.

6. Run migrations after restore if the code is newer than the backup:

```bash
cd /home/void0000/Desktop/VOIDAPP/VOID0000-api
npm run migrate
```

7. Start the app:

```bash
pm2 start /home/void0000/Desktop/VOIDAPP/VOID0000-api/ecosystem.config.cjs --update-env
pm2 save
```

8. Check health:

```bash
./scripts/check-health.sh
```

## Important Limitations

- Scylla CSV export is okay for this project while it is small. If message
  volume gets serious, move to Scylla snapshots or a real backup manager.
- Backups contain sensitive data. Even if chat bodies and attachments are
  encrypted, account data, emails, metadata, sessions, and encrypted key backups
  still need protection.
- Do not commit backups to Git.
- Do not store the only backup on the same disk forever.
- Test restore before trusting the backup.
