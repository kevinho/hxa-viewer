/**
 * hxa-viewer server
 *
 * Standalone document management server for browsing, rendering, and managing
 * collections of Markdown documents with optional git-based version history.
 *
 * Configuration priority (highest wins):
 *   1. Environment variables  (HXAVIEWER_PORT, HXAVIEWER_CONTENT_DIR, ...)
 *   2. Config JSON file       (HXAVIEWER_CONFIG env or ../config.json)
 *   3. Built-in defaults
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.HXAVIEWER_CONFIG
    || path.resolve(__dirname, '..', 'config.json');

let fileConfig = {};
try {
    if (fs.existsSync(CONFIG_PATH)) {
        fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
} catch (err) {
    console.warn(`[!] Could not load config from ${CONFIG_PATH}: ${err.message}`);
}

/**
 * Resolve a config value.  Environment variable takes precedence over the
 * config-file value, which takes precedence over the default.  Paths from
 * the config file are resolved relative to the config file's directory.
 */
function cfg(envKey, fileValue, fallback) {
    const raw = process.env[envKey] || fileValue || fallback;
    // Resolve relative paths against the config file's directory
    if (typeof raw === 'string' && raw.startsWith('./')) {
        return path.resolve(path.dirname(CONFIG_PATH), raw);
    }
    return raw;
}

const PORT           = parseInt(process.env.HXAVIEWER_PORT || fileConfig.port || 3460, 10);
const CONTENT_DIR    = cfg('HXAVIEWER_CONTENT_DIR', fileConfig.contentDir, './data/content');
const TREE_CONFIG    = cfg('HXAVIEWER_TREE_CONFIG', fileConfig.treeConfigPath, './data/tree-config.json');
const UPLOADS_DIR    = cfg('HXAVIEWER_UPLOADS_DIR', fileConfig.uploadsDir, './data/uploads');
const GIT_ENABLED    = process.env.HXAVIEWER_GIT_ENABLED === 'true'
    || (fileConfig.git && fileConfig.git.enabled)
    || false;
const GIT_REPO_DIR   = cfg('HXAVIEWER_GIT_REPO', fileConfig.git && fileConfig.git.repoDir, '');
const VIEWER_DIR     = path.resolve(__dirname, '..', 'viewer');

// Ensure required directories exist
fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(TREE_CONFIG), { recursive: true });

// Create a default tree-config.json if it does not exist
if (!fs.existsSync(TREE_CONFIG)) {
    fs.writeFileSync(TREE_CONFIG, JSON.stringify({ version: 1, folders: [], trash: [] }, null, 2));
    console.log(`[+] Created default tree config at ${TREE_CONFIG}`);
}

console.log('[*] hxa-viewer config:');
console.log(`    PORT         = ${PORT}`);
console.log(`    CONTENT_DIR  = ${CONTENT_DIR}`);
console.log(`    TREE_CONFIG  = ${TREE_CONFIG}`);
console.log(`    UPLOADS_DIR  = ${UPLOADS_DIR}`);
console.log(`    GIT_ENABLED  = ${GIT_ENABLED}`);
if (GIT_ENABLED) console.log(`    GIT_REPO_DIR = ${GIT_REPO_DIR}`);
console.log(`    VIEWER_DIR   = ${VIEWER_DIR}`);

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS headers for development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ---------------------------------------------------------------------------
// Image upload (multer)
// ---------------------------------------------------------------------------

let multer;
try {
    multer = require('multer');
} catch {
    console.warn('[!] multer not installed — image upload will be disabled');
}

let upload;
if (multer) {
    upload = multer({
        storage: multer.diskStorage({
            destination: UPLOADS_DIR,
            filename: (_req, file, cb) => {
                const ext = path.extname(file.originalname || '.png');
                const name = Date.now() + '-' + Math.random().toString(36).substr(2, 6) + ext;
                cb(null, name);
            }
        }),
        limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
        fileFilter: (_req, file, cb) => {
            const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']);
            const ext = path.extname(file.originalname || '').toLowerCase();
            cb(null, file.mimetype.startsWith('image/') && ALLOWED_EXT.has(ext));
        }
    });
}

// ---------------------------------------------------------------------------
// Helper: safe path resolution (prevents path traversal)
// ---------------------------------------------------------------------------

function safePath(baseDir, userPath) {
    const resolved = path.resolve(baseDir, userPath);
    if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
        return null;
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// Helper: safe tree-config write (atomic via tmp + rename)
// ---------------------------------------------------------------------------

function writeTreeConfig(tc) {
    tc.version = (tc.version || 0) + 1;
    const tmp = TREE_CONFIG + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(tc, null, 2));
    fs.renameSync(tmp, TREE_CONFIG);
    return tc.version;
}

function readTreeConfig() {
    return JSON.parse(fs.readFileSync(TREE_CONFIG, 'utf8'));
}

// ---------------------------------------------------------------------------
// Helper: recursively find folders by id
// ---------------------------------------------------------------------------

function findInFolders(folders, predicate) {
    for (const f of folders) {
        if (predicate(f)) return f;
        if (f.children) {
            const found = findInFolders(f.children, predicate);
            if (found) return found;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Routes — Health
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        contentDir: CONTENT_DIR,
        gitEnabled: GIT_ENABLED
    });
});

// ---------------------------------------------------------------------------
// Routes — Document listing
// ---------------------------------------------------------------------------

/**
 * GET /documents
 * List all markdown files in the content directory (recursive).
 */
app.get('/documents', (_req, res) => {
    try {
        const files = [];

        function scan(dir, prefix) {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const filePath = path.join(dir, entry);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    scan(filePath, prefix + entry + '/');
                } else if (entry.endsWith('.md')) {
                    const content = fs.readFileSync(filePath, 'utf8').substring(0, 500);
                    const titleMatch = content.match(/^#\s+(.+)/m);
                    const versionMatch = content.match(/版本[：:]\s*v?([\d.]+)/i)
                        || content.match(/[Vv]([\d.]+)\s*\|/);
                    files.push({
                        path: prefix + entry,
                        name: entry,
                        title: titleMatch ? titleMatch[1] : entry.replace('.md', ''),
                        version: versionMatch ? versionMatch[1] : null,
                        modified: stat.mtime.toISOString()
                    });
                }
            }
        }

        // Scan "docs/" subdirectory if it exists
        const docsDir = path.join(CONTENT_DIR, 'docs');
        if (fs.existsSync(docsDir)) {
            scan(docsDir, 'docs/');
        }

        // Also scan root content dir for top-level .md files
        const rootEntries = fs.readdirSync(CONTENT_DIR)
            .filter(f => f.endsWith('.md') && !f.startsWith('.'));
        for (const entry of rootEntries) {
            const filePath = path.join(CONTENT_DIR, entry);
            const stat = fs.statSync(filePath);
            if (!stat.isDirectory()) {
                const content = fs.readFileSync(filePath, 'utf8').substring(0, 500);
                const titleMatch = content.match(/^#\s+(.+)/m);
                files.push({
                    path: entry,
                    name: entry,
                    title: titleMatch ? titleMatch[1] : entry.replace('.md', ''),
                    version: null,
                    modified: stat.mtime.toISOString()
                });
            }
        }

        files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
        res.json({ files });
    } catch (err) {
        console.error('Failed to list documents:', err.message);
        res.json({ files: [] });
    }
});

// ---------------------------------------------------------------------------
// Routes — Document modification time
// ---------------------------------------------------------------------------

/**
 * GET /doc-mtime?doc=<path>
 * Returns { mtime, iso } for polling-based auto-refresh.
 */
app.get('/doc-mtime', (req, res) => {
    const { doc } = req.query;
    if (!doc) return res.status(400).json({ error: 'Missing doc parameter' });

    const filePath = safePath(CONTENT_DIR, doc);
    if (!filePath) return res.status(400).json({ error: 'Invalid path' });

    try {
        const stat = fs.statSync(filePath);
        res.json({ mtime: stat.mtimeMs, iso: stat.mtime.toISOString() });
    } catch {
        res.status(404).json({ error: 'File not found' });
    }
});

// ---------------------------------------------------------------------------
// Routes — Git version history (optional)
// ---------------------------------------------------------------------------

/**
 * GET /versions?doc=<path>
 * Returns array of { version, hash, date, file, commitHash, isCurrent }.
 * Requires git to be enabled and a valid git repo directory.
 */
app.get('/versions', (req, res) => {
    const { doc } = req.query;
    if (!doc) return res.status(400).json({ error: 'Missing doc parameter' });

    if (!GIT_ENABLED || !GIT_REPO_DIR) {
        return res.json([]);
    }

    try {
        const absDocPath = safePath(CONTENT_DIR, doc);
        if (!absDocPath) return res.status(400).json({ error: 'Invalid path' });
        let realPath;
        try {
            // Follow symlinks if present
            realPath = fs.realpathSync(absDocPath);
        } catch {
            realPath = absDocPath;
        }

        // Make path relative to the git repo
        const relPath = path.relative(GIT_REPO_DIR, realPath);

        const logResult = spawnSync('git', ['log', '--follow', '--format=%H|%aI', '--', relPath], {
            cwd: GIT_REPO_DIR, encoding: 'utf8', timeout: 5000
        });
        const gitLog = (logResult.stdout || '').trim();

        if (!gitLog) return res.json([]);

        const commits = gitLog.split('\n').filter(Boolean);
        const versions = [];
        const seenVersions = new Set();

        for (const line of commits) {
            const [hash, date] = line.split('|');
            try {
                const showResult = spawnSync('git', ['show', `${hash}:${relPath}`], {
                    cwd: GIT_REPO_DIR, encoding: 'utf8', timeout: 3000
                });
                const content = showResult.stdout || '';
                const vMatch = content.match(/版本[：:]\s*v?([\d.]+)/i);
                if (vMatch && !seenVersions.has(vMatch[1])) {
                    seenVersions.add(vMatch[1]);
                    versions.push({
                        version: vMatch[1],
                        hash: hash.substring(0, 8),
                        date: date.substring(0, 10),
                        file: doc,
                        commitHash: hash,
                        isCurrent: versions.length === 0
                    });
                }
            } catch {
                // Skip commits where file doesn't exist yet
            }
        }

        res.json(versions);
    } catch (err) {
        console.error('Failed to get versions:', err.message);
        res.json([]);
    }
});

/**
 * GET /version-content?doc=<path>&hash=<commitHash>
 * Returns the raw file content from a specific git commit.
 */
app.get('/version-content', (req, res) => {
    const { doc, hash } = req.query;
    if (!doc || !hash) return res.status(400).json({ error: 'Missing doc or hash parameter' });
    if (!/^[a-f0-9]{4,40}$/i.test(hash)) return res.status(400).json({ error: 'Invalid hash format' });

    if (!GIT_ENABLED || !GIT_REPO_DIR) {
        return res.status(404).json({ error: 'Git version history is not enabled' });
    }

    try {
        const absDocPath = safePath(CONTENT_DIR, doc);
        if (!absDocPath) return res.status(400).json({ error: 'Invalid path' });
        let realPath;
        try {
            realPath = fs.realpathSync(absDocPath);
        } catch {
            realPath = absDocPath;
        }

        const relPath = path.relative(GIT_REPO_DIR, realPath);

        const result = spawnSync('git', ['show', `${hash}:${relPath}`], {
            cwd: GIT_REPO_DIR, encoding: 'utf8', timeout: 5000
        });
        if (result.status !== 0) return res.status(404).json({ error: 'Version not found' });

        res.type('text/plain').send(result.stdout);
    } catch {
        res.status(404).json({ error: 'Version not found' });
    }
});

// ---------------------------------------------------------------------------
// Routes — Tree config management
// ---------------------------------------------------------------------------

/**
 * POST /tree-config
 * Save an updated tree configuration.
 * Body: { config: { folders: [...], ... }, user?: string }
 */
app.post('/tree-config', (req, res) => {
    const { config } = req.body;
    if (!config || !config.folders) {
        return res.status(400).json({ error: 'Invalid config: missing folders array' });
    }
    try {
        const version = writeTreeConfig(config);
        res.json({ success: true, version });
    } catch (err) {
        console.error('Failed to save tree config:', err.message);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ---------------------------------------------------------------------------
// Routes — File management
// ---------------------------------------------------------------------------

/**
 * POST /create-file
 * Create a new markdown file in the content directory.
 * Body: { filename, title, folderId?, user? }
 */
app.post('/create-file', (req, res) => {
    const { filename, title, folderId } = req.body;
    if (!filename || !title) {
        return res.status(400).json({ error: 'Missing filename or title' });
    }

    // Sanitize filename: keep alphanumeric, CJK, hyphens, underscores, dots
    let safeName = filename.replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_.]/g, '');
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    if (!safeName.endsWith('.md')) safeName += '.md';

    const filePath = path.join(CONTENT_DIR, safeName);
    if (fs.existsSync(filePath)) {
        return res.status(400).json({ error: 'File already exists: ' + safeName });
    }

    const content = `# ${title}\n\n`;
    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o644);

    // Optionally add the file to a folder in tree-config
    if (folderId) {
        try {
            const tc = readTreeConfig();
            function addToFolder(folders) {
                for (const f of folders) {
                    if (f.id === folderId) {
                        if (!f.files) f.files = [];
                        f.files.push(safeName);
                        return true;
                    }
                    if (f.children && addToFolder(f.children)) return true;
                }
                return false;
            }
            addToFolder(tc.folders);
            writeTreeConfig(tc);
        } catch (err) {
            console.error('Failed to update tree config:', err.message);
        }
    }

    res.json({ success: true, path: safeName });
});

/**
 * POST /trash-file
 * Soft-delete a file by moving it to the trash section in tree-config.
 * The physical file is NOT deleted; it is just removed from folder listings.
 * Body: { filePath, user? }
 */
app.post('/trash-file', (req, res) => {
    const { filePath: docPath, user } = req.body;
    if (!docPath) return res.status(400).json({ error: 'Missing filePath' });
    if (!safePath(CONTENT_DIR, docPath)) return res.status(400).json({ error: 'Invalid path' });

    try {
        const tc = readTreeConfig();
        if (!tc.trash) tc.trash = [];

        // Remove file from all folders
        let fromFolder = null;
        function removeFromFolders(folders) {
            for (const f of folders) {
                if (f.files) {
                    const idx = f.files.indexOf(docPath);
                    if (idx !== -1) {
                        f.files.splice(idx, 1);
                        fromFolder = f.id;
                    }
                }
                if (f.children) removeFromFolders(f.children);
            }
        }
        removeFromFolders(tc.folders);

        // Try to extract title from the physical file
        let title = docPath;
        const physPath = safePath(CONTENT_DIR, docPath);
        if (physPath && fs.existsSync(physPath)) {
            const content = fs.readFileSync(physPath, 'utf8');
            const m = content.match(/^#\s+(.+)/m);
            if (m) title = m[1];
        }

        tc.trash.push({
            path: docPath,
            title,
            deletedAt: new Date().toISOString(),
            deletedBy: user || 'unknown',
            fromFolder
        });

        writeTreeConfig(tc);
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to trash file:', err.message);
        res.status(500).json({ error: 'Failed to trash file' });
    }
});

/**
 * POST /restore-file
 * Restore a file from the trash back into a folder.
 * Body: { filePath, targetFolder? }
 */
app.post('/restore-file', (req, res) => {
    const { filePath: docPath, targetFolder } = req.body;
    if (!docPath) return res.status(400).json({ error: 'Missing filePath' });
    if (!safePath(CONTENT_DIR, docPath)) return res.status(400).json({ error: 'Invalid path' });

    try {
        const tc = readTreeConfig();
        if (!tc.trash) return res.status(404).json({ error: 'No trash items' });

        const idx = tc.trash.findIndex(t => t.path === docPath);
        if (idx === -1) return res.status(404).json({ error: 'File not in trash' });

        const trashItem = tc.trash[idx];
        const restoreTo = targetFolder || trashItem.fromFolder;

        if (restoreTo) {
            function addToFolder(folders) {
                for (const f of folders) {
                    if (f.id === restoreTo) {
                        if (!f.files) f.files = [];
                        if (!f.files.includes(docPath)) f.files.push(docPath);
                        return true;
                    }
                    if (f.children && addToFolder(f.children)) return true;
                }
                return false;
            }
            if (!addToFolder(tc.folders)) {
                // Fallback: add to the first top-level folder
                if (tc.folders.length > 0) {
                    if (!tc.folders[0].files) tc.folders[0].files = [];
                    tc.folders[0].files.push(docPath);
                }
            }
        }

        tc.trash.splice(idx, 1);
        writeTreeConfig(tc);
        res.json({ success: true, restoredTo: restoreTo });
    } catch (err) {
        console.error('Failed to restore file:', err.message);
        res.status(500).json({ error: 'Failed to restore file' });
    }
});

/**
 * DELETE /permanent-delete
 * Permanently delete a file from trash AND the filesystem.
 * Body: { filePath }
 */
app.delete('/permanent-delete', (req, res) => {
    const { filePath: docPath } = req.body;
    if (!docPath) return res.status(400).json({ error: 'Missing filePath' });
    if (!safePath(CONTENT_DIR, docPath)) return res.status(400).json({ error: 'Invalid path' });

    try {
        const tc = readTreeConfig();
        if (!tc.trash) return res.status(404).json({ error: 'No trash items' });

        const idx = tc.trash.findIndex(t => t.path === docPath);
        if (idx === -1) return res.status(404).json({ error: 'File not in trash' });

        tc.trash.splice(idx, 1);

        // Delete the physical file
        const physPath = safePath(CONTENT_DIR, docPath);
        if (physPath && fs.existsSync(physPath)) {
            fs.unlinkSync(physPath);
        }

        writeTreeConfig(tc);
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to permanently delete:', err.message);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ---------------------------------------------------------------------------
// Routes — Folder management
// ---------------------------------------------------------------------------

/**
 * POST /create-folder
 * Create a new folder in the tree config.
 * Body: { name, parentFolderId? }
 */
app.post('/create-folder', (req, res) => {
    const { name, parentFolderId } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Missing folder name' });
    }

    try {
        const tc = readTreeConfig();

        // Generate a slug-style folder id
        const baseId = name.trim().toLowerCase()
            .replace(/[\u4e00-\u9fff]/g, m => m)
            .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
            .replace(/^-|-$/g, '') || ('folder-' + Date.now());

        // Deduplicate id if necessary
        function hasId(folders, id) {
            for (const f of folders) {
                if (f.id === id) return true;
                if (f.children && hasId(f.children, id)) return true;
            }
            return false;
        }
        let folderId = baseId;
        if (hasId(tc.folders, folderId)) {
            folderId = baseId + '-' + Date.now().toString(36);
        }

        const newFolder = { id: folderId, name: name.trim(), files: [] };

        if (parentFolderId) {
            function addToParent(folders) {
                for (const f of folders) {
                    if (f.id === parentFolderId) {
                        if (!f.children) f.children = [];
                        f.children.push(newFolder);
                        return true;
                    }
                    if (f.children && addToParent(f.children)) return true;
                }
                return false;
            }
            if (!addToParent(tc.folders)) {
                return res.status(400).json({ error: 'Parent folder not found' });
            }
        } else {
            tc.folders.push(newFolder);
        }

        const version = writeTreeConfig(tc);
        res.json({ success: true, folderId, version });
    } catch (err) {
        console.error('Failed to create folder:', err.message);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// ---------------------------------------------------------------------------
// Routes — Image upload
// ---------------------------------------------------------------------------

/**
 * POST /upload-image
 * Upload a document image. Returns { success, url }.
 */
if (upload) {
    app.post('/upload-image', upload.single('image'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }
        const url = '/images/' + req.file.filename;
        res.json({ success: true, url });
    });
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

// Serve uploaded images at /images/
app.use('/images', express.static(UPLOADS_DIR));

// Serve tree-config.json at /tree-config.json
app.get('/tree-config.json', (_req, res) => {
    try {
        const data = fs.readFileSync(TREE_CONFIG, 'utf8');
        res.type('application/json').send(data);
    } catch {
        res.status(404).json({ error: 'tree-config.json not found' });
    }
});

// Serve raw markdown files at /raw/*
app.get('/raw/*', (req, res) => {
    const relativePath = req.params[0];
    const filePath = safePath(CONTENT_DIR, relativePath);
    if (!filePath) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read file' });
    }
});

// Serve the viewer HTML at root /
if (fs.existsSync(VIEWER_DIR)) {
    app.use(express.static(VIEWER_DIR));
    // SPA fallback: any non-API route that doesn't match a static file → index.html
    app.get('*', (req, res, next) => {
        // Don't intercept API-like paths already handled above
        if (req.path.startsWith('/raw/') || req.path.startsWith('/images/')) {
            return next();
        }
        const indexPath = path.join(VIEWER_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
            return res.sendFile(indexPath);
        }
        next();
    });
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
    console.log(`[+] hxa-viewer server running on port ${PORT}`);
});

module.exports = app;
