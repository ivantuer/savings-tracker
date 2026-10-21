// Public identifiers for sync, built into the app so devices only need the passphrase and a Google sign-in.
// Neither value is a secret: the server only accepts Google tokens issued for this client ID, from the owner's account.
// Fill both in after deploying the Worker and creating the Google OAuth client; while empty, Settings asks for them.
export const SYNC_URL = '';
export const GOOGLE_CLIENT_ID = '';
