# Agora Web SDK (vendored)

`AgoraRTC_N-4.24.9.min.js` is `AgoraRTC_N-production.min.js` from the npm
package `agora-rtc-sdk-ng` 4.24.9 (MIT, see `LICENSE`), unchanged:

    sha256 ce21d532d9ecc26815591886a99fafaa46c20d42aa80cd0f996f8dd6b6c82b3e

The chat page loads it only when the owner opens a talk with an assistant's
avatar (`web/public/avatar-live.js`): the avatar service publishes the face on
an Agora channel and the browser watches it.

It is a copy and not an npm dependency because the package pulls 44 packages
(about 34 MB) into every installation for this one browser file, and the page
must not load scripts from another origin.

## Updating

1. `npm pack agora-rtc-sdk-ng@<version>` and unpack it.
2. Copy `package/AgoraRTC_N-production.min.js` here as
   `AgoraRTC_N-<version>.min.js`, delete the old file and update the sha256
   above.
3. Update the file name in `web/public/avatar-live.js`.
4. The origins the SDK talks to are allowed in the page's CSP by `avatarCsp`
   in `web/avatar.mjs`; check them against the new version's docs.
