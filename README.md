# yashnarbek-dev.github.io

My terminal-style portfolio: https://yashnarbek-dev.github.io

## Editing the site (admin panel)

Everything on the site (every text in every language, links, projects, songs, chess accounts, photo, resume, colors, menus, commands and features) is edited at:

**https://yashnarbek-dev.github.io/admin** (or type `admin` in the terminal)

It asks for the admin password (change it in the panel under **Settings → Admin password**; only a PBKDF2 hash of it is stored in `content.json`).

The very first time, it also needs a GitHub token so it can save changes. The token is saved in `content.json` encrypted (AES-256-GCM, key derived from the admin password with PBKDF2), so after that the password alone works on any device:

1. Open https://github.com/settings/personal-access-tokens/new
2. Repository access: **Only select repositories** → `yashnarbek-dev.github.io`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Expiration: the longest one offered (the panel asks for a new token when it runs out).
5. Generate the token and paste it into the admin panel.

Then edit, check the live preview on the right, and press **Publish**. The site updates about a minute later.

- Unpublished changes are kept as a draft in your browser, so closing the tab loses nothing.
- **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo, **/** searches every text on the site, **Ctrl+S** publishes.
- **Custom commands** adds new terminal commands with your own text, links and images.
- **Raw JSON** downloads or restores a backup of all content.

The admin password is what protects the site, so keep it long and private.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | The terminal: reads `content.json` and renders it |
| `content.json` | **All content**, edited by the admin panel |
| `admin.html`, `admin.js` | The admin panel |
| `assets/photo.jpg` | Photo on the About card |
| `assets/portrait.json` | 3D ASCII portrait data (made from the original photo) |
| `assets/` | Files uploaded from the admin panel |
| `Yashnarbek_Gofirjonov_Resume.pdf` | Resume |

## Running it locally

The site loads `content.json` with `fetch`, so it needs a local web server instead of opening the file directly:

```
python -m http.server 8000
```

Then open http://localhost:8000 (site) or http://localhost:8000/admin.html (admin).
