# Equipment Inventory System

A lightweight, mobile-friendly equipment inventory dashboard backed by Google Sheets and Google Apps Script.

## Current features

- Live equipment data from Google Sheets
- Search and status filtering
- Responsive desktop and mobile inventory views
- Click any equipment row or its three-dot action to edit it
- Add new equipment records
- Dynamic fields based on Sheet columns
- System-managed `Last_Updated` field (visible, but not user-editable)
- QR camera scanner, QR image scanning, and manual ID lookup
- Printable and downloadable equipment QR labels
- CSV export for visible or selected equipment

## Technology

- HTML, CSS, and vanilla JavaScript
- Google Sheets database
- Google Apps Script API
- `html5-qrcode` for scanning
- Local `qrcode.js` dependency for label generation

## Run locally

Camera access requires a secure context. `localhost` is accepted by modern browsers for development.

```powershell
python -m http.server 8765
```

Open `http://localhost:8765` in a browser.

## Project files

- `index.html` — application structure
- `style.css` — responsive dashboard design
- `app.js` — inventory, API, scanner, editor, export, and label behavior
- `qrcode.min.js` — local QR generation dependency

## Deployment

The frontend can be hosted on GitHub Pages or Cloudflare Pages. Production deployment must use HTTPS so mobile camera access works.

## Backend contract

The configured Google Apps Script endpoint must support:

- Fetching the complete equipment list
- Fetching an equipment record by ID
- `CREATE` requests for new equipment
- `UPDATE` requests for existing equipment
- Automatic maintenance of `Last_Updated`
- Audit-log creation for mutations

Do not trust browser-supplied values for timestamps, identity, permissions, or audit records. These must be enforced by the Apps Script backend.
