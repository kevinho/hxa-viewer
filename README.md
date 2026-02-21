# HxA Viewer

Document tree navigator and Markdown renderer — browse, render, and manage collections of Markdown documents.

## Features

- **Tree Navigation** — Hierarchical folder/file tree with expand/collapse, drag-drop reorder, and persistent state
- **Markdown Rendering** — GitHub-flavored Markdown via marked.js with syntax highlighting (highlight.js) and sanitization (DOMPurify)
- **Table of Contents** — Auto-generated from headings with scroll spy and responsive drawer mode
- **Search** — Real-time filtering across file titles in the sidebar
- **File Management** — Create, rename, trash, restore, and permanently delete documents and folders
- **Version History** — Git-based version tracking with version selector and historical content viewing
- **Responsive Layout** — Collapsible sidebar, resizable panels, mobile-friendly breakpoints
- **Image Upload** — Paste or upload images into documents

## Quick Start

```bash
npm install
cp server/config.example.json config.json  # edit as needed
npm start
```

Then open `http://localhost:3460` in your browser.

## Configuration

### Config file (`config.json`)

```json
{
  "port": 3460,
  "contentDir": "./data/content",
  "treeConfigPath": "./data/tree-config.json",
  "uploadsDir": "./data/uploads",
  "git": {
    "enabled": false,
    "repoDir": ""
  }
}
```

### Environment variables

Environment variables override config file values.

| Variable | Default | Description |
|----------|---------|-------------|
| `HXAVIEWER_PORT` | `3460` | Server port |
| `HXAVIEWER_CONTENT_DIR` | `./data/content` | Directory for Markdown files |
| `HXAVIEWER_TREE_CONFIG` | `./data/tree-config.json` | Tree structure config path |
| `HXAVIEWER_UPLOADS_DIR` | `./data/uploads` | Image upload directory |
| `HXAVIEWER_GIT_ENABLED` | `false` | Enable git-based version history |
| `HXAVIEWER_GIT_REPO` | — | Git repository directory for version history |
| `HXAVIEWER_CONFIG` | `../config.json` | Config file path |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/documents` | List all Markdown files |
| GET | `/doc-mtime?doc=<path>` | Get file modification time |
| GET | `/versions?doc=<path>` | Get version history (requires git) |
| GET | `/version-content?doc=<path>&hash=<hash>` | Get file content at specific version |
| POST | `/tree-config` | Save tree configuration |
| POST | `/create-file` | Create a new Markdown file |
| POST | `/create-folder` | Create a new folder |
| POST | `/trash-file` | Move file to trash |
| POST | `/restore-file` | Restore file from trash |
| DELETE | `/permanent-delete` | Permanently delete a trashed file |
| POST | `/upload-image` | Upload an image |
| GET | `/raw/*` | Serve raw Markdown content |
| GET | `/tree-config.json` | Get tree configuration |
| GET | `/health` | Health check |

## Architecture

```
hxa-viewer/
├── server/
│   ├── index.js              Express server with document management API
│   └── config.example.json   Configuration template
├── viewer/
│   └── index.html            Single-page viewer application
├── data/                     Runtime data (gitignored)
│   ├── content/              Markdown documents
│   ├── uploads/              Uploaded images
│   └── tree-config.json      Tree structure
└── package.json
```

The viewer is a self-contained single-page application. All UI (tree, renderer, TOC, search, file management) lives in `viewer/index.html` with inline CSS and JavaScript — no build step required.

The server provides a REST API for document CRUD operations and serves the viewer as static files.

## Frontend Configuration

The viewer connects to the server via `window.HXA_VIEWER_API`:

```html
<script>window.HXA_VIEWER_API = 'http://localhost:3460';</script>
```

When not set, it defaults to the same origin (which works when served by the built-in server).

## License

MIT
