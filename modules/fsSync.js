import { initHashAB, recomputeITunesCDBHash, computeLocationsCBK, parseUUID } from './hashAB.js';

/**
 * Inject CreateIsHomeVideo into every UserVersionCommandSets Commands array
 * that lacks it. Set 26 omits this command, but libgpod picks the max set
 * and the Nano 7 needs the is_home_video column to display music.
 * @param {string} plistString - Full plist XML string
 * @returns {{ content: string, createIsHomeVideoInjected: boolean }}
 */
function patchSysInfoExtended(plistString) {
    let s = plistString;

    const commandsArrayRe = /(<key>Commands<\/key>\s*\n\s*<array>)([\s\S]*?)(<\/array>)/g;
    let createIsHomeVideoInjected = false;
    s = s.replace(commandsArrayRe, (match, open, body, close) => {
        if (body.includes('CreateIsHomeVideo')) return match;
        createIsHomeVideoInjected = true;
        return open + '\n            <string>CreateIsHomeVideo</string>' + body + close;
    });

    return { content: s, createIsHomeVideoInjected };
}

export function createFsSync({ log, wasm, mountpoint = '/iPod' }) {
    function getFS() {
        const Module = wasm.getModule();
        return Module?.FS;
    }

    async function listDirNames(dirHandle, limit = 50) {
        const names = [];
        try {
            for await (const [name] of dirHandle.entries()) {
                names.push(name);
                if (names.length >= limit) break;
            }
        } catch (_) {
            // ignore
        }
        names.sort((a, b) => a.localeCompare(b));
        return names;
    }

    async function verifyIpodStructure(handle) {
        try {
            const controlDir = await handle.getDirectoryHandle('iPod_Control', { create: false });

            let itunesDir;
            try {
                itunesDir = await controlDir.getDirectoryHandle('iTunes', { create: false });
            } catch (e) {
                const names = await listDirNames(controlDir);
                log(`Missing iPod_Control/iTunes. Found in iPod_Control: ${names.join(', ') || '(empty)'}`, 'error');
                return false;
            }

            // Classic layout: iTunesDB present.
            const hasClassicDb = await (async () => {
                try {
                    await itunesDir.getFileHandle('iTunesDB', { create: false });
                    return true;
                } catch {
                    return false;
                }
            })();

            if (hasClassicDb) {
                log('Found iPod_Control/iTunes/iTunesDB', 'success');
                return true;
            }

            // Modern layout: iTunesCDB + iTunes Library.itlp (sqlite bundle) present.
            const hasModernLayout = await (async () => {
                try {
                    await itunesDir.getFileHandle('iTunesCDB', { create: false });
                } catch {
                    return false;
                }
                try {
                    // On newer devices the sqlite DBs live in "iTunes Library.itlp"
                    await itunesDir.getDirectoryHandle('iTunes Library.itlp', { create: false });
                } catch {
                    try {
                        // Older docs mention "iTunes Library" without the .itlp suffix
                        await itunesDir.getDirectoryHandle('iTunes Library', { create: false });
                    } catch {
                        return false;
                    }
                }
                return true;
            })();

            if (hasModernLayout) {
                log('Found iTunesCDB and iTunesControl (sqlite layout) - treating as valid iPod database', 'info');
                return true;
            }

            const names = await listDirNames(itunesDir);
            log(`Missing classic iTunesDB and modern iTunesCDB/iTunesControl. Found in iTunes: ${names.join(', ') || '(empty)'}`, 'error');
            return false;
        } catch (e) {
            const names = await listDirNames(handle);
            log(`Missing iPod_Control in selected folder. Found: ${names.join(', ') || '(empty)'}`, 'error');
            return false;
        }
    }

    async function setupWasmFilesystem(handle, options = {}) {
        log('Setting up virtual filesystem for WASM...');
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        // Create mountpoint
        try { FS.mkdir(mountpoint); } catch (_) {}

        // Set mountpoint in WASM
        wasm.wasmCallWithStrings('ipod_set_mountpoint', [mountpoint]);

        // Create directory structure
        const dirs = [
            `${mountpoint}/iPod_Control`,
            `${mountpoint}/iPod_Control/iTunes`,
            `${mountpoint}/iPod_Control/Device`,
            `${mountpoint}/iPod_Control/Music`
        ];
        dirs.forEach(dir => { try { FS.mkdir(dir); } catch (_) {} });

        // Create Music subfolders F00-F49
        for (let i = 0; i < 50; i++) {
            const folder = `F${String(i).padStart(2, '0')}`;
            try { FS.mkdir(`${mountpoint}/iPod_Control/Music/${folder}`); } catch (_) {}
        }

        await syncIpodToVirtualFS(handle);

        // SysInfoExtended is required only for models that use it (Nano 5th/6th/7th gen).
        // Classics and older nanos don't have it; requiring it would break them.
        const sysInfoExtendedPath = `${mountpoint}/iPod_Control/Device/SysInfoExtended`;
        let sysInfoExtendedVisible = false;
        try {
            FS.stat(sysInfoExtendedPath);
            sysInfoExtendedVisible = true;
        } catch (_) {
            // file missing
        }
        const needsSysInfoExtended = options?.needsSysInfoExtended === true;
        if (!sysInfoExtendedVisible && needsSysInfoExtended) {
            const msg = 'SysInfoExtended is not available. Ensure the selected folder is an iPod with Device/SysInfoExtended (e.g. Nano 7). Post-process commands will not run and the device may not show music correctly.';
            log(msg, 'error');
            console.error('[TunesReloaded]', msg);
            throw new Error(msg);
        }
        if (!sysInfoExtendedVisible && !needsSysInfoExtended) {
            log('SysInfoExtended not present (not required for this model)', 'info');
        }

        log('Virtual filesystem ready', 'success');
    }

    async function syncIpodToVirtualFS(handle) {
        log('Syncing iPod files to virtual filesystem...');
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        const iPodControlHandle = await handle.getDirectoryHandle('iPod_Control', { create: false });
        const iTunesHandle = await iPodControlHandle.getDirectoryHandle('iTunes', { create: false });

        // Copy classic iTunesDB if present
        try {
            const dbFileHandle = await iTunesHandle.getFileHandle('iTunesDB', { create: false });
            const dbFile = await dbFileHandle.getFile();
            const dbData = new Uint8Array(await dbFile.arrayBuffer());
            FS.writeFile(`${mountpoint}/iPod_Control/iTunes/iTunesDB`, dbData);
            log(`Synced: iTunesDB (${dbData.length} bytes)`, 'info');
        } catch (e) {
            const names = await listDirNames(iTunesHandle);
            log(`iTunesDB not found (this is expected on newer models). Found in iTunes: ${names.join(', ') || '(empty)'}`, 'info');
        }

        // Copy compressed iTunesCDB if present (modern / iOS-style layout)
        try {
            const cdbHandle = await iTunesHandle.getFileHandle('iTunesCDB', { create: false });
            const cdbFile = await cdbHandle.getFile();
            const cdbData = new Uint8Array(await cdbFile.arrayBuffer());
            FS.writeFile(`${mountpoint}/iPod_Control/iTunes/iTunesCDB`, cdbData);
            log(`Synced: iTunesCDB (${cdbData.length} bytes)`, 'info');
        } catch (_) {
            // fine on classic models
        }

        // Recursively copy a real directory into the WASM virtual filesystem.
        async function copyDirToVfs(realDirHandle, vfsDirPath) {
            const FS = getFS();
            if (!FS) throw new Error('WASM FS not ready');

            // Ensure directory exists in VFS
            try { FS.mkdir(vfsDirPath); } catch (_) {}

            for await (const [name, entry] of realDirHandle.entries()) {
                const childPath = `${vfsDirPath}/${name}`;
                if (entry.kind === 'file') {
                    try {
                        const file = await entry.getFile();
                        const data = new Uint8Array(await file.arrayBuffer());
                        FS.writeFile(childPath, data);
                    } catch (_) {
                        // best-effort
                    }
                } else if (entry.kind === 'directory') {
                    const subDir = await realDirHandle.getDirectoryHandle(name, { create: false });
                    await copyDirToVfs(subDir, childPath);
                }
            }
        }

        // Copy sqlite tree (iTunes Library.itlp / iTunes Library / iTunesControl).
        // This MUST be awaited — otherwise, if the user syncs before the copy
        // finishes, the late-completing copy could overwrite freshly generated
        // sqlite databases with stale originals from the iPod.
        try {
            const itlpDir = await iTunesHandle.getDirectoryHandle('iTunes Library.itlp', { create: false });
            await copyDirToVfs(itlpDir, `${mountpoint}/iPod_Control/iTunes/iTunes Library.itlp`);
            log('Synced: iTunes Library.itlp (sqlite databases)', 'info');
        } catch (_) {
            // fall through — try alternate names
            try {
                const itunesLibDir = await iTunesHandle.getDirectoryHandle('iTunes Library', { create: false });
                await copyDirToVfs(itunesLibDir, `${mountpoint}/iPod_Control/iTunes/iTunes Library`);
                log('Synced: iTunes Library (sqlite databases)', 'info');
            } catch (_2) {
                // As a last resort, try iTunesControl (older docs / some devices).
                try {
                    const ctrlDir = await iTunesHandle.getDirectoryHandle('iTunesControl', { create: false });
                    await copyDirToVfs(ctrlDir, `${mountpoint}/iPod_Control/iTunes/iTunesControl`);
                    log('Synced: iTunesControl (sqlite databases)', 'info');
                } catch (_3) {
                    // fine on classic models
                }
            }
        }

        // Copy SysInfo and SysInfoExtended (optional). Patch SysInfoExtended
        // to remove CreateRentalExpiredColumn when the column already exists (avoids duplicate-column error).
        try {
            const deviceHandle = await iPodControlHandle.getDirectoryHandle('Device');
            await copyDeviceFile(deviceHandle, 'SysInfo');
            await copySysInfoExtendedMaybePatched(deviceHandle);
        } catch (e) {
            log(`Device directory error: ${e.message}`, 'warning');
        }

        log('File sync complete', 'success');
    }

    async function copyDeviceFile(deviceHandle, filename) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');
        try {
            const fileHandle = await deviceHandle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            const data = new Uint8Array(await file.arrayBuffer());
            FS.writeFile(`${mountpoint}/iPod_Control/Device/${filename}`, data);
            log(`Synced: ${filename} (${data.length} bytes)`, 'info');
        } catch (e) {
            if (filename === 'SysInfo') {
                log(`SysInfo file not found: ${e.message}`, 'warning');
            }
        }
    }

    async function copySysInfoExtendedMaybePatched(deviceHandle) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');
        try {
            const fileHandle = await deviceHandle.getFileHandle('SysInfoExtended');
            const file = await fileHandle.getFile();
            let content = await file.text();
            const { content: patched, createIsHomeVideoInjected } = patchSysInfoExtended(content);
            content = patched;
            if (createIsHomeVideoInjected) {
                log('SysInfoExtended patch: CreateIsHomeVideo injected into Commands array(s)', 'info');
            }
            const data = new TextEncoder().encode(content);
            FS.writeFile(`${mountpoint}/iPod_Control/Device/SysInfoExtended`, data);
            log(`Synced: SysInfoExtended (${data.length} bytes)`, 'info');
        } catch (e) {
            // SysInfoExtended optional; no warning needed
        }
    }

    // Reserve a destination path in MEMFS (empty file) to avoid name collisions
    // when libgpod generates random filenames based on filesystem existence checks.
    function reserveVirtualPath(virtualPath) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');
        const vp = String(virtualPath || '');
        if (!vp) return;

        try {
            // Ensure parent directories exist
            const parts = vp.split('/').filter(p => p);
            let dirPath = '';
            for (let i = 0; i < parts.length - 1; i++) {
                dirPath += '/' + parts[i];
                try { FS.mkdir(dirPath); } catch (_) {}
            }

            // If file already exists, keep it
            try {
                FS.stat(vp);
                return;
            } catch (_) {
                // create empty placeholder
            }
            FS.writeFile(vp, new Uint8Array());
        } catch (_) {
            // best-effort only
        }
    }

    async function writeFileToIpodRelativePath(ipodHandle, relativePath, file, { onProgress } = {}) {
        if (!ipodHandle) throw new Error('No iPod handle');
        if (!file) throw new Error('No file provided');

        const parts = String(relativePath || '').split('/').filter(Boolean);
        if (parts.length === 0) throw new Error('Invalid destination path');

        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);

        // Create directories as needed
        let currentDir = ipodHandle;
        for (const dir of dirParts) {
            currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
        }

        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();

        // Use native stream piping for better throughput (still constant-memory).
        // If progress is needed, count bytes via a TransformStream.
        const total = Number(file.size || 0);
        let readable = file.stream();

        if (typeof onProgress === 'function' && total > 0) {
            let written = 0;
            readable = readable.pipeThrough(new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(chunk);
                    written += chunk?.byteLength || 0;
                    const percent = Math.round((written / total) * 100);
                    try { onProgress({ written, total, percent }); } catch (_) {}
                }
            }));
        }

        try {
            // pipeTo will close the destination stream on success.
            await readable.pipeTo(writable);
        } catch (e) {
            // Best-effort abort to release the file handle.
            try { await writable.abort(e); } catch (_) {}
            throw e;
        }
    }

    async function syncDbToIpod(ipodHandle, { onProgress } = {}) {
        if (!ipodHandle) return { ok: false, errorCount: 1, syncedCount: 0, skippedCount: 0 };

        const FS = getFS();
        if (!FS) return { ok: false, errorCount: 1, syncedCount: 0, skippedCount: 0 };

        // On compressed-DB devices (Nano 5G+, 7G), libgpod writes the binary
        // database to iTunesCDB (compressed + hashAB signed) and empties iTunesDB.
        // The iTunesCDB and the sqlite databases in itlp MUST be synced together —
        // the iPod firmware validates them as a consistent set. Writing one without
        // the other causes a mismatch → "no music".
        //
        // IMPORTANT: Do NOT write a 0-byte iTunesDB to the iPod when iTunesCDB
        // exists. Modern iPods (Nano 5G+) do not have an iTunesDB file at all
        // after an iTunes restore. Creating a 0-byte iTunesDB where none existed
        // may confuse the firmware into trying to parse it instead of iTunesCDB.
        let hasCDB = false;
        try {
            const cdbData = FS.readFile(`${mountpoint}/iPod_Control/iTunes/iTunesCDB`);
            hasCDB = cdbData.length > 0;
        } catch (_) {}

        const tasks = [];
        if (!hasCDB) {
            // Classic layout — iTunesDB is the primary database
            tasks.push({ virtualPath: `${mountpoint}/iPod_Control/iTunes/iTunesDB`, fileName: 'iTunesDB', optional: false });
        }
        tasks.push({ virtualPath: `${mountpoint}/iPod_Control/iTunes/iTunesSD`, fileName: 'iTunesSD', optional: true });
        if (hasCDB) {
            tasks.push({ virtualPath: `${mountpoint}/iPod_Control/iTunes/iTunesCDB`, fileName: 'iTunesCDB', optional: false });
        }

        let done = 0;
        let errorCount = 0;
        let syncedCount = 0;

        const iPodControlHandle = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
        const iTunesHandle = await iPodControlHandle.getDirectoryHandle('iTunes', { create: true });

        // Sync individual database files (iTunesDB, iTunesSD, iTunesCDB)
        for (const t of tasks) {
            const ok = await syncVirtualFileToRealInternal(iTunesHandle, t.virtualPath, t.fileName, t.optional);
            if (!ok && !t.optional) errorCount += 1;
            if (ok) syncedCount += 1;
            done += 1;
        }

        // Sync sqlite databases in "iTunes Library.itlp" (used by Nano 5G+, 7G, etc.)
        // These are the databases the iPod firmware actually reads for its music UI.
        const itlpVfsPath = `${mountpoint}/iPod_Control/iTunes/iTunes Library.itlp`;
        let itlpFiles = [];
        try {
            itlpFiles = FS.readdir(itlpVfsPath).filter(n => n !== '.' && n !== '..');
        } catch (_) {
            // No itlp directory in VFS — classic-layout iPod, nothing to do.
        }

        if (itlpFiles.length > 0) {
            log(`Syncing ${itlpFiles.length} sqlite database file(s) from iTunes Library.itlp`, 'info');

            let itlpDir;
            try {
                itlpDir = await iTunesHandle.getDirectoryHandle('iTunes Library.itlp', { create: true });
            } catch (e) {
                log(`Failed to open/create iTunes Library.itlp on iPod: ${e.message}`, 'error');
                errorCount += 1;
            }
            if (itlpDir) {
                for (const fileName of itlpFiles) {
                    const vfsFilePath = `${itlpVfsPath}/${fileName}`;
                    // Skip subdirectories (only copy files)
                    try {
                        const stat = FS.stat(vfsFilePath);
                        if (FS.isDir(stat.mode)) continue;
                    } catch (_) {
                        continue;
                    }
                    const ok = await syncVirtualFileToRealInternal(itlpDir, vfsFilePath, fileName, false);
                    if (!ok) errorCount += 1;
                    if (ok) syncedCount += 1;
                    done += 1;
                }
            }
        }

        const total = done;
        const percent = 100;
        try { onProgress?.({ phase: 'ipod', current: total, total, percent, detail: 'done' }); } catch (_) {}

        return { ok: errorCount === 0, errorCount, syncedCount, skippedCount: 0 };
    }

    async function syncVirtualFileToRealInternal(realDirHandle, virtualPath, fileName, optional = false) {
        const FS = getFS();
        if (!FS) throw new Error('WASM FS not ready');

        try {
            try {
                FS.stat(virtualPath);
            } catch (_) {
                if (!optional) log(`File not found in virtual FS: ${virtualPath}`, 'warning');
                return false;
            }

            const data = FS.readFile(virtualPath);
            const fileHandle = await realDirHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(data);
            await writable.close();
            log(`Synced ${fileName} to iPod`, 'info');
            return true;
        } catch (e) {
            if (!optional) log(`Failed to sync ${fileName}: ${e.message}`, 'warning');
            return false;
        }
    }

    async function deleteFileFromIpodRelativePath(ipodHandle, relativePath) {
        if (!ipodHandle) throw new Error('No iPod handle');
        const parts = String(relativePath || '').split('/').filter(Boolean);
        if (parts.length === 0) throw new Error('Invalid destination path');

        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);

        let currentDir = ipodHandle;
        for (const dir of dirParts) {
            currentDir = await currentDir.getDirectoryHandle(dir, { create: false });
        }

        // Spec: FileSystemDirectoryHandle.removeEntry(name, { recursive? })
        await currentDir.removeEntry(fileName, { recursive: false });
    }

    /**
     * Re-sign iTunesCDB and Locations.itdb.cbk in the VFS using the
     * standalone calcHashAB.wasm (known-good Zig implementation).
     *
     * Call this after ipod_write_db (which signs with the emscripten-compiled
     * C calcHashAB that may produce incorrect signatures) and before
     * syncDbToIpod copies files to the real iPod.
     *
     * @param {string} firewireGuidHex — 16-char hex string (e.g. "000A2700248F5308")
     */
    async function reSignDatabaseFiles(firewireGuidHex) {
        const FS = getFS();
        if (!FS) {
            log('reSignDatabaseFiles: WASM FS not ready', 'warning');
            return;
        }

        const hex = String(firewireGuidHex || '').replace(/^0x/i, '');
        if (!/^[0-9a-fA-F]{16}$/.test(hex)) {
            log(`reSignDatabaseFiles: invalid FirewireGuid "${firewireGuidHex}" — skipping`, 'warning');
            return;
        }

        const uuid = parseUUID(hex);
        await initHashAB();

        log(`Re-signing database files with hashAB (UUID: ${hex})`, 'info');

        // Re-sign iTunesCDB
        const cdbPath = `${mountpoint}/iPod_Control/iTunes/iTunesCDB`;
        try {
            const cdbData = FS.readFile(cdbPath);
            if (cdbData.length > 0) {
                const signed = await recomputeITunesCDBHash(new Uint8Array(cdbData), uuid);
                FS.writeFile(cdbPath, signed);
                log('Re-signed iTunesCDB with hashAB', 'info');
            }
        } catch (e) {
            log(`iTunesCDB not found or re-sign failed: ${e?.message || e}`, 'warning');
        }

        // Re-sign Locations.itdb.cbk
        const itlpDir = `${mountpoint}/iPod_Control/iTunes/iTunes Library.itlp`;
        const locPath = `${itlpDir}/Locations.itdb`;
        const cbkPath = `${itlpDir}/Locations.itdb.cbk`;
        try {
            const locData = FS.readFile(locPath);
            if (locData.length > 0) {
                const cbk = await computeLocationsCBK(new Uint8Array(locData), uuid);
                FS.writeFile(cbkPath, cbk);
                log('Re-signed Locations.itdb.cbk with hashAB', 'info');
            }
        } catch (e) {
            log(`Locations.itdb re-sign failed: ${e?.message || e}`, 'warning');
        }
    }

    /**
     * Write ArtworkDB + .ithmb files to the iPod's Artwork directory.
     * @param {FileSystemDirectoryHandle} ipodHandle
     * @param {Uint8Array} artworkDb — ArtworkDB binary
     * @param {Map<string, Uint8Array>} ithmbs — filename → pixel data
     */
    async function writeArtworkFiles(ipodHandle, artworkDb, ithmbs) {
        if (!ipodHandle) throw new Error('No iPod handle');

        const controlDir = await ipodHandle.getDirectoryHandle('iPod_Control', { create: true });
        const artDir = await controlDir.getDirectoryHandle('Artwork', { create: true });

        // Write ArtworkDB
        const dbHandle = await artDir.getFileHandle('ArtworkDB', { create: true });
        const dbWritable = await dbHandle.createWritable();
        await dbWritable.write(artworkDb);
        await dbWritable.close();
        log?.(`Wrote ArtworkDB (${artworkDb.length} bytes)`, 'info');

        // Write .ithmb files
        for (const [filename, data] of ithmbs) {
            const fh = await artDir.getFileHandle(filename, { create: true });
            const w = await fh.createWritable();
            await w.write(data);
            await w.close();
            log?.(`Wrote ${filename} (${data.length} bytes)`, 'info');
        }
    }

    /**
     * Scan iPod_Control/Artwork/ for existing .ithmb files.
     * Returns array of format IDs found (e.g. [1055, 1060]).
     */
    async function scanExistingIthmbs(ipodHandle) {
        if (!ipodHandle) return [];
        try {
            const ctrl = await ipodHandle.getDirectoryHandle('iPod_Control', { create: false });
            const artDir = await ctrl.getDirectoryHandle('Artwork', { create: false });
            const formatIds = [];
            for await (const [name] of artDir.entries()) {
                const m = name.match(/^F(\d+)_\d+\.ithmb$/i);
                if (m) formatIds.push(parseInt(m[1], 10));
            }
            return [...new Set(formatIds)].sort((a, b) => a - b);
        } catch (_) {
            return [];
        }
    }

    /**
     * Read the SysInfoExtended plist from MEMFS (if available).
     * Returns the XML string or null.
     */
    function readSysInfoExtendedFromVFS() {
        const FS = getFS();
        if (!FS) return null;
        try {
            return FS.readFile(`${mountpoint}/iPod_Control/Device/SysInfoExtended`, { encoding: 'utf8' });
        } catch (_) {
            return null;
        }
    }

    return {
        mountpoint,
        verifyIpodStructure,
        setupWasmFilesystem,
        syncDbToIpod,
        writeFileToIpodRelativePath,
        reserveVirtualPath,
        deleteFileFromIpodRelativePath,
        reSignDatabaseFiles,
        writeArtworkFiles,
        readSysInfoExtendedFromVFS,
        scanExistingIthmbs,
    };
}

