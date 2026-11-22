# yashnarbek-dev.github.io

My terminal-style portfolio: https://yashnarbek-dev.github.io

## Editing the site (admin panel)

Everything on the site (every text in every language, links, projects, songs, chess accounts, photo, resume, colors, menus, commands and features) is edited at:

**https://yashnarbek-dev.github.io/admin** (or type `admin` in the terminal)

It asks for the admin password first (change it in the panel under **Settings → Admin password**; only a PBKDF2 hash of it is stored in `content.json`).

The first time on each device, it also needs a GitHub token so it can save changes:

1. Open https://github.com/settings/personal-access-tokens/new
2. Repository access: **Only select repositories** → `yashnarbek-dev.github.io`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Generate the token and paste it into the admin panel.

Then edit, check the live preview on the right, and press **Publish**. The site updates about a minute later.

- Unpublished changes are kept as a draft in your browser, so closing the tab loses nothing.
- **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo, **/** searches every text on the site, **Ctrl+S** publishes.
- **Custom commands** adds new terminal commands with your own text, links and images.
- **Raw JSON** downloads or restores a backup of all content.

Nobody can change the site without both the password and a GitHub token with write access to this repository.

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
