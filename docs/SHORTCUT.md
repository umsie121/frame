# iOS Shortcut: "Send to Frame" (free)

Adds **Send to Frame** to the iPhone/iPad Share Sheet. It converts to frame-friendly formats
(JPEG photos, H.264 video — the frame can't decode HEIC or HEVC) and uploads straight to the frame
over the home Wi-Fi. No accounts, no cloud.

1. On the frame: tap → **Photos**, scan the QR code, and copy the page address
   (looks like `http://<frame-ip>:8787/u/AbC123…`).
2. iPhone → **Shortcuts** → **+** → name it **Send to Frame**.
3. Tap **ⓘ** → **Show in Share Sheet** → types: **Images** and **Media**.
4. **Repeat with Each** item in *Shortcut Input*, and inside it:
   - **If** *Repeat Item* *is* **Video** (type) →
     **Encode Media** *Repeat Item*: Size **1280×720**, **turn HEVC off** → set variable *File*
   - **Otherwise** → **Convert Image** *Repeat Item* to **JPEG** → set variable *File*
   - **Get Contents of URL**: your upload link · Method **POST** · Header `X-Sender` = your name ·
     Request Body **Form** → File field named `file` = *File*
5. After the repeat: **Show Notification** "Sent to the frame".

Share it with family via iCloud link. Works on the home Wi-Fi only. Duplicates are ignored.
If the frame's upload link is rotated, update the URL in the shortcut.
