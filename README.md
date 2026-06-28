Oleffi shared backend setup

1. Install Node.js on the computer that will keep the shared company data.
2. Open the `oleffi_backend` folder.
3. Start the backend:
   - double-click `start-backend.bat`
   - or run `node server.js`
4. Keep that backend computer on the same network as the phones, or host it on a public server.
5. Find that computer's IP address.
6. Open `C:\Users\raju1\Documents\Codex\2026-05-05\files-mentioned-by-the-user-index\oleffi_backend_config.js`
7. Change:
   - `enabled: false` to `enabled: true`
   - `apiBase` to your server address, for example:
     - `http://192.168.1.50:8787/api`
8. Copy both updated files into Android Studio assets:
   - `oleffi_android_studio.html`
   - `oleffi_backend_config.js`
9. Rebuild and install the app.

How it will work

- Admin registers the company once.
- The app gives a `Company Code`.
- Admin shares this `Company Code` with Production and Quality users.
- Team members log in using:
  - Company Code
  - Username
  - Password
- Admin can add, update, disable, or remove team users from Settings.
- Production, Quality, Machines, Lists, and Records are stored in the shared backend instead of one phone only.

Important

- The backend computer/server must stay running.
- All phones must be able to reach the backend address.
- If you change backend address later, update `oleffi_backend_config.js` and rebuild the app.
