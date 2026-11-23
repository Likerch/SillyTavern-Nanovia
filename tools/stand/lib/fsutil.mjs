// File helpers for the stand. Windows-friendly: directory links are junctions, and removal never follows a link
// (a junction to a shared folder must not take that folder with it).
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** True for symlinks and Windows junctions (lstat reports both as links). */
export function isLink(target) {
    try {
        return fs.lstatSync(target).isSymbolicLink();
    } catch {
        return false;
    }
}

export function exists(target) {
    try {
        fs.lstatSync(target);
        return true;
    } catch {
        return false;
    }
}

/** Deletes a file or a directory tree. Links (junctions, symlinks) are removed, never entered. */
export function removeTree(target) {
    let stat;
    try {
        stat = fs.lstatSync(target);
    } catch {
        return;
    }
    if (stat.isSymbolicLink()) {
        try {
            fs.unlinkSync(target);
        } catch {
            fs.rmdirSync(target);
        }
        return;
    }
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
        fs.rmdirSync(target);
        return;
    }
    try {
        fs.unlinkSync(target);
    } catch (error) {
        if (error.code !== 'EPERM') throw error;
        fs.chmodSync(target, 0o666);
        fs.unlinkSync(target);
    }
}

/** Creates a directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
export function linkDir(target, linkPath) {
    removeTree(linkPath);
    ensureDir(path.dirname(linkPath));
    fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

export function readJson(file, fallback = undefined) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (fallback !== undefined) return fallback;
        throw error;
    }
}

export function writeJson(file, value, indent = 4) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, indent) + '\n', 'utf8');
}
