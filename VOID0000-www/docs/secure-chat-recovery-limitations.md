# Secure Chat Recovery Limitation

Note:

This file keeps its old name for link stability, but it is about the current encrypted-chat / chat-key recovery path. It should not be read as a casual claim that the project is broadly "secure."

## Current Model

The app currently uses:

- account-scope chat identity
- password-backed encrypted chat backup
- durable MLS state sync for group state, welcomes, commits, and archived keys

This means the server stores encrypted chat recovery material, but it does not know the plaintext private key.

## Important Limitation

`Change Password` and `Forgot Password` do not behave the same for encrypted-chat recovery.

### Change Password while authenticated

When the user is already logged in on a device that still has the local chat key:

- the client re-encrypts the same chat private key with the new password
- the server backup is updated with the new password wrapper
- old chats remain recoverable

### Forgot Password / Reset Password

When the user resets the account password through the reset flow:

- the account password hash is changed
- the encrypted-chat key backup is **not** automatically re-wrapped
- the chat backup may still require the **old password**

This means a user can successfully recover the account login, but still get blocked on encrypted-chat recovery in a fresh browser or new device.

## What Still Works

- A device that already has the local chat state can usually keep reading old chats.
- If a surviving device logs in and refreshes the backup, it may repair the password-wrapped backup for future logins.
- Durable MLS sync can restore conversation state once the chat key backup is successfully unlocked.

## What Fails

These conditions together are the risky case:

- user forgot the old password
- user reset the account password
- user is on a fresh browser/device or lost the old local chat state

In that case, the user may recover the account but still be unable to recover old encrypted chats.

## Why This Exists

This is not just a UI problem. It is a consequence of the current crypto model:

- the server can change the account password hash
- the server cannot re-encrypt the encrypted-chat key backup by itself
- the plaintext chat key only exists on a device that already has local encrypted state

## Accepted Tradeoff For Now

We are documenting this limitation and moving forward without solving it yet.

Current accepted behavior:

- authenticated password change preserves chat recovery
- forgot-password reset does **not** guarantee chat recovery on a fresh device

## Future Recovery Options

If we want to solve this later, the real options are:

1. surviving-device-assisted recovery
2. explicit recovery key / recovery code
3. server-assisted escrow recovery

We are **not** implementing those yet in this branch.
