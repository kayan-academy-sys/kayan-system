# Kayan encrypted local recovery

This is a recovery-code package, not a database backup. Keep it with the encrypted .kayan file. Keep the file's passphrase separately in a password manager. Never put it in chat.

The file includes application table records, applied migration files/checksums, table counts and sequence state. It includes private customer/financial/staff data and password hashes. It does not include hosting-account settings, environment secrets, provider roles or independent files. Recovery requires a compatible Node.js and PostgreSQL environment and the matching reviewed migration source. Custom live schema changes outside those migrations need separate review; do not assume this file captures them.

Create a new EMPTY PostgreSQL database for recovery. Never point this tool at the working database. The tool refuses nonempty targets. Restore migration SQL must match the reviewed local source exactly. The encrypted file is AES-256-GCM, PBKDF2-HMAC-SHA256, 600000 iterations. Wrong keys or altered ciphertext fail authentication.

The recovery program reads these environment settings:
- TARGET_DATABASE_URL: the explicitly selected separate empty database
- CONFIRM_ISOLATED_EMPTY_DATABASE=yes
- BACKUP_PASSWORD_FILE: path to a private local file containing the passphrase. Restrict its permissions and delete it after recovery. Do not type a real passphrase into a command line or conversation.

Run: node scripts/restore-local-backup.js /path/to/recovery.kayan

The program reports restored:true only after commit. Afterward reconcile table counts, relationships, key booking/financial totals and application access. A restored database is not automatically a live site. Reconfigure hosting/session/cron secrets through secure tools, and do not activate business jobs or route users without the reviewed recovery plan.

The interface records a snapshot request separately from the user's manual confirmation that the file is saved. The website does not inspect the device filesystem. If no eligible user opens the site or the site is unavailable, no local copy is obtained. Keep more than one dated copy and a second trusted device/medium under the owner's policy. This is not guaranteed unattended offsite protection.
