# Encrypted Chat Recovery Notes

Note:

This file keeps its old name for link stability, but it is about the current encrypted-chat / chat-key recovery path. It should not be read as a casual claim that the project is broadly "secure."

## Current Model

The app currently uses:

- account-scope chat identity
- password-backed encrypted chat backup
- recovery-key-backed encrypted chat backup
- durable MLS state sync for group state, welcomes, commits, and archived keys

This means the server stores encrypted chat recovery material, but it does not know the plaintext private key.

## Current Recovery Paths

There are now two recovery wrappers:

- account-password wrapper
- explicit recovery-key wrapper

The recovery key is created from Account settings. The app shows it once, and the user has to save it somewhere safe. After refresh, the app can tell that a recovery key is configured, but it cannot show the existing key again.

Rotating the recovery key replaces the old recovery-key backup. That is why the UI asks for confirmation before rotating.

## Password And Recovery Key Behavior

`Change Password` and `Forgot Password` do not behave the same for encrypted-chat recovery.

### Change Password while authenticated

When the user is already logged in on a device that still has the local chat key:

- the client re-encrypts the same chat private key with the new password
- the server backup is updated with the new password wrapper
- if the current browser has the stored recovery key, the recovery-key wrapper can also be refreshed
- old chats remain recoverable

### Forgot Password / Reset Password

When the user resets the account password through the reset flow:

- the account password hash is changed
- the encrypted-chat key backup is **not** automatically re-wrapped
- the password-backed chat backup may still require the **old password**
- a saved recovery key can recover the chat identity without depending on that old account password

This means a user can successfully recover the account login, but still get blocked on encrypted-chat recovery in a fresh browser or new device if they never created or saved a recovery key.

## What Still Works

- A device that already has the local chat state can usually keep reading old chats.
- If a surviving device logs in and refreshes the backup, it may repair the password-wrapped backup for future logins.
- If a user saved the recovery key, a fresh browser can use that key to restore the chat identity and recovery-key-wrapped MLS backup.
- Durable MLS sync can restore conversation state once the chat key backup is successfully unlocked.

## What Fails

These conditions together are the risky case:

- user forgot the old password
- user reset the account password
- user did not create or save the recovery key
- user is on a fresh browser/device or lost the old local chat state

In that case, the user may recover the account but still be unable to recover old encrypted chats.

## Why This Exists

This is not just a UI problem. It is a consequence of the current crypto model:

- the server can change the account password hash
- the server cannot re-encrypt the encrypted-chat key backup by itself
- the server cannot reveal or recreate the user's recovery key
- the plaintext chat key only exists on a device that already has local encrypted state

## Current Tradeoffs

This is better than the old password-only recovery model, but it is still not magic.

Current accepted behavior:

- authenticated password change preserves chat recovery when the current device has the chat key
- recovery key setup gives the user a password-independent restore path
- forgot-password reset still does **not** guarantee chat recovery on a fresh device if the user did not save a recovery key
- the current browser may store the recovery key locally in an encrypted browser record so it can refresh recovery-key backups later
- legacy password backup still exists for older accounts and fallback recovery paths

## Future Recovery Options

If we want to improve this later, the real options are:

1. surviving-device-assisted recovery
2. better recovery-key UX and reminders
3. server-assisted escrow recovery

We are not doing server-assisted escrow right now.
