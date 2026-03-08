import { parseAlbumArtFormats, generateArtworkFiles, patchITunesDbArtwork, lookupFormatSpecs, debugPreviewIthmb, extractExactDbids, parseExistingArtworkDb } from './artworkWriter.js';
// import { recomputeHash58, parseUUID } from './hashAB.js';
// ↑ Disabled: JS hash58 doesn't match libgpod's; using libgpod's hash as-is
// import { rebuildIndexSections } from './indexBuilder.js';  // disabled: see note in saveDatabase

export function createSyncPipeline({
    appState,
    wasm,
    fsSync,
    paths,
    log,
    logWasmError,
    modals,
    refreshCurrentView,
    rerenderAllTracksIfVisible,
    getOrComputeQueuedMeta,
    readAudioMetadata,
    transcodeFlacToAlacM4a,
    getFiletypeFromName,
    formatDuration,
    firewireSetup,
} = {}) {
    function setUploadModalState({ title, status, detail, percent, showOk, okLabel } = {}) {
        const titleEl = document.getElementById('uploadTitle');
        const statusEl = document.getElementById('uploadStatus');
        const detailEl = document.getElementById('uploadDetail');
        const barEl = document.getElementById('uploadProgress');
        const actionsEl = document.getElementById('uploadActions');
        const okBtn = document.getElementById('uploadOkBtn');

        if (titleEl && typeof title === 'string') titleEl.textContent = title;
        if (statusEl && typeof status === 'string') statusEl.textContent = status;
        if (detailEl && typeof detail === 'string') detailEl.textContent = detail;
        if (barEl && Number.isFinite(percent)) barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;

        if (actionsEl) actionsEl.style.display = showOk ? 'flex' : 'none';
        if (okBtn && typeof okLabel === 'string') okBtn.textContent = okLabel;
    }

    function dismissUploadModal() {
        setUploadModalState({
            title: 'Uploading',
            status: 'Preparing...',
            detail: '',
            percent: 0,
            showOk: false,
            okLabel: 'OK',
        });
        modals.hideUpload();
    }

    function updateUploadProgress(current, total, filename) {
        const percent = Math.round((current / total) * 100);
        setUploadModalState({
            title: 'Uploading...',
            status: `Uploading... ${current} of ${total}`,
            detail: filename,
            percent,
            showOk: false,
        });
    }

    /**
     * Resolve artwork data for a track from multiple sources.
     * Returns Uint8Array (JPEG/PNG bytes) or null.
     */
    async function resolveArtwork(file, artworkFile, precomputedArtwork) {
        // 1. Pre-computed artwork (e.g. extracted from FLAC before transcoding)
        if (precomputedArtwork && precomputedArtwork.byteLength > 0) {
            return precomputedArtwork;
        }

        // 2. Embedded artwork from the audio file
        try {
            const metaWithArt = await readAudioMetadata(file, { extractCovers: true });
            if (metaWithArt.artwork && metaWithArt.artwork.byteLength > 0) {
                return metaWithArt.artwork;
            }
        } catch (_) {}

        // 3. External artwork file
        if (artworkFile) {
            try {
                const buf = await artworkFile.arrayBuffer();
                return new Uint8Array(buf);
            } catch (_) {}
        }

        return null;
    }

    /**
     * Upload a single track to the iPod database and filesystem.
     * Returns { ok, trackIndex, dbid, artworkData } for artwork collection.
     */
    async function uploadSingleTrack(file, precomputedMeta = null, { destName, artworkFile, precomputedArtwork } = {}) {
        if (!file) return { ok: false };
        const meta = precomputedMeta || (await getOrComputeQueuedMeta(null, file));
        const audioProps = {
            duration: meta.durationMs,
            bitrate: meta.bitrateKbps,
            samplerate: meta.samplerateHz,
        };

        const effectiveName = String(destName || file.name || 'track');
        const filetype = getFiletypeFromName(effectiveName);

        const trackIndex = wasm.wasmAddTrack({
            title: meta.title || file.name.replace(/\.[^/.]+$/, ''),
            artist: meta.artist,
            album: meta.album,
            genre: meta.genre,
            trackNr: meta.trackNr || 0,
            cdNr: 0,
            year: meta.year || 0,
            durationMs: audioProps.duration,
            bitrateKbps: audioProps.bitrate,
            samplerateHz: audioProps.samplerate,
            sizeBytes: file.size,
            filetype,
        });

        if (trackIndex < 0) {
            logWasmError?.('Failed to add track');
            return { ok: false };
        }

        // Resolve artwork (don't apply yet — collected for batch ArtworkDB write)
        let artworkData = null;
        try {
            artworkData = await resolveArtwork(file, artworkFile, precomputedArtwork);
        } catch (e) {
            log?.(`Artwork warning: ${e?.message || e}`, 'warning');
        }

        // Get the track's dbid for artwork linking
        let dbid = 0;
        try {
            const trackJson = wasm.wasmGetJson('ipod_get_track_json', trackIndex);
            dbid = trackJson?.dbid || 0;
        } catch (_) {}

        const destPathPtr = wasm.wasmCallWithStrings('ipod_get_track_dest_path', [effectiveName]);
        if (!destPathPtr) {
            log?.('Failed to get destination path', 'error');
            return { ok: false };
        }

        const destPath = wasm.wasmGetString(destPathPtr);
        wasm.wasmCall('ipod_free_string', destPathPtr);
        if (!destPath) {
            log?.('Failed to read destination path', 'error');
            return { ok: false };
        }

        const relFsPath = paths.toRelFsPathFromVfs(destPath);

        // Reserve this path in MEMFS to avoid collisions when generating multiple tracks.
        try { fsSync.reserveVirtualPath(destPath); } catch (_) {}

        // Upload audio directly to the real iPod filesystem (no MEMFS audio staging)
        try {
            await fsSync.writeFileToIpodRelativePath(appState.ipodHandle, relFsPath, file);
        } catch (e) {
            log?.(`Failed to write file to iPod: ${e?.message || e}`, 'error');
            wasm.wasmCallWithError('ipod_remove_track', trackIndex);
            return { ok: false };
        }

        // Finalize track metadata WITHOUT requiring the file to exist in MEMFS.
        const finalizePathPtr = wasm.wasmAllocString(destPath);
        const result = wasm.wasmCallWithError('ipod_finalize_last_track_no_stat', finalizePathPtr, file.size);
        wasm.wasmFreeString(finalizePathPtr);

        if (result !== 0) {
            const ipodPath = paths.toIpodDbPathFromRel(relFsPath) || '';
            const setPathRes = wasm.wasmCallWithStrings('ipod_track_set_path', [ipodPath], [trackIndex]);
            if (setPathRes !== 0) {
                wasm.wasmCallWithError('ipod_remove_track', trackIndex);
                return { ok: false };
            }
        }

        // Add to the current playlist — but skip the master playlist (MPL)
        // because ipod_add_track() already adds every new track to the MPL.
        const idx = appState.currentPlaylistIndex;
        if (idx >= 0 && idx < appState.playlists.length) {
            const pl = appState.playlists[idx];
            if (!pl.is_master) {
                wasm.wasmCall('ipod_playlist_add_track', idx, trackIndex);
            }
        }

        log?.(`Added: ${meta.title || file.name} (${formatDuration(audioProps.duration)})`, 'success');
        return { ok: true, trackIndex, dbid, artworkData };
    }

    async function saveDatabase() {
        if (!appState.isConnected) {
            log?.('Please connect an iPod first', 'warning');
            return;
        }

        modals.showUpload();
        setUploadModalState({
            title: 'Uploading',
            status: 'Preparing...',
            detail: '',
            percent: 0,
            showOk: false,
        });

        // Artwork collector: dbid → imageData (JPEG/PNG bytes)
        const artworkEntries = [];

        // 1) Process queued uploads
        const queue = appState.pendingUploads || [];
        const toStage = queue.filter((q) => q.status !== 'staged');
        if (toStage.length > 0) {
            log?.(`Staging ${toStage.length} queued track(s)...`, 'info');
            setUploadModalState({ status: `Uploading... (${toStage.length} track${toStage.length !== 1 ? 's' : ''})` });

            // Keep iPod writes sequential, but allow up to 2 FLAC transcodes to run concurrently
            // in the background (via the transcode pool).
            let completed = 0;
            const total = toStage.length;

            let uploadChain = Promise.resolve();
            const enqueueUpload = (fn) => {
                const next = uploadChain.then(fn, fn);
                uploadChain = next.catch(() => {});
                return next;
            };

            const flacTasks = [];

            // Kick off FLAC transcodes early so they can overlap with MP3 uploads.
            for (const item of toStage) {
                const file = item.kind === 'handle' ? await item.handle.getFile() : item.file;
                const lowerName = String(file?.name || '').toLowerCase();
                if (!lowerName.endsWith('.flac')) continue;

                const task = (async () => {
                    try {
                        setUploadModalState({
                            title: 'Uploading...',
                            status: 'Converting FLACs (up to 2 at a time)...',
                            detail: file.name,
                            percent: Math.round((completed / total) * 100),
                            showOk: false,
                        });

                        const meta = await getOrComputeQueuedMeta(item, file);

                        // Extract artwork from original FLAC before transcoding (transcoding strips it)
                        let flacArtwork = null;
                        try {
                            const flacMeta = await readAudioMetadata(file, { extractCovers: true });
                            flacArtwork = flacMeta.artwork;
                        } catch (_) {}

                        const m4aFile = await transcodeFlacToAlacM4a(file);

                        const outMeta = await readAudioMetadata(m4aFile);
                        const combinedMeta = {
                            title: meta.title || outMeta.tags.title,
                            artist: meta.artist || outMeta.tags.artist,
                            album: meta.album || outMeta.tags.album,
                            genre: meta.genre || outMeta.tags.genre,
                            trackNr: meta.trackNr || outMeta.tags.track || 0,
                            year: meta.year || outMeta.tags.year || 0,
                            durationMs: outMeta.props.duration,
                            bitrateKbps: outMeta.props.bitrate,
                            samplerateHz: outMeta.props.samplerate,
                        };

                        await enqueueUpload(async () => {
                            updateUploadProgress(completed + 1, total, m4aFile.name);
                            const res = await uploadSingleTrack(m4aFile, combinedMeta, {
                                destName: m4aFile.name,
                                artworkFile: item.artworkFile,
                                precomputedArtwork: flacArtwork,
                            });
                            if (res.ok) {
                                item.status = 'staged';
                                if (res.dbid && res.artworkData) {
                                    artworkEntries.push({ dbid: res.dbid, imageData: res.artworkData });
                                }
                            }
                            completed += 1;
                            updateUploadProgress(completed, total, m4aFile.name);
                        });
                    } catch (e) {
                        log?.(`FLAC convert failed: ${e?.message || e}`, 'error');
                    }
                })();

                flacTasks.push(task);
            }

            // Process non-FLAC uploads sequentially (while FLAC transcodes run in background).
            for (const item of toStage) {
                const file = item.kind === 'handle' ? await item.handle.getFile() : item.file;
                const lowerName = String(file?.name || '').toLowerCase();
                if (lowerName.endsWith('.flac')) continue; // handled by background tasks

                const meta = await getOrComputeQueuedMeta(item, file);
                await enqueueUpload(async () => {
                    updateUploadProgress(completed + 1, total, file?.name || item.name || 'Unknown');
                    const res = await uploadSingleTrack(file, meta, { artworkFile: item.artworkFile });
                    if (res.ok) {
                        item.status = 'staged';
                        if (res.dbid && res.artworkData) {
                            artworkEntries.push({ dbid: res.dbid, imageData: res.artworkData });
                        }
                    }
                    completed += 1;
                    updateUploadProgress(completed, total, file?.name || item.name || 'Unknown');
                });
            }

            await Promise.allSettled(flacTasks);
            await uploadChain;

            appState.pendingUploads = [...queue];
            rerenderAllTracksIfVisible?.();
        }

        // 2) Write iTunesDB
        {
            const trackCount = wasm.wasmCall('ipod_get_track_count');
            log?.(`Syncing iPod database... (${trackCount} tracks in memory)`, 'info');
            console.log(`[SyncDiag] Track count before ipod_write_db: ${trackCount}`);

            // ── MPL member count BEFORE ipod_write_db ──
            // ipod_write_db() validates playlists and may remove members.
            // Compare before/after to detect if validation is removing tracks.
            const plsBefore = wasm.wasmGetJson('ipod_get_all_playlists_json');
            const mplBefore = plsBefore?.find(p => p.is_master);
            console.log(`[SyncDiag] MPL member count BEFORE ipod_write_db: ${mplBefore?.track_count ?? '?'} (track list: ${trackCount})`);
            if (mplBefore && mplBefore.track_count !== trackCount) {
                log?.(`⚠ MPL/track mismatch BEFORE write: MPL=${mplBefore.track_count}, tracks=${trackCount}`, 'warning');
            }
        }
        setUploadModalState({ status: 'Preparing database...', detail: '' });
        const result = wasm.wasmCallWithError('ipod_write_db');
        if (result !== 0) {
            setUploadModalState({
                title: 'Upload failed',
                status: 'Failed to prepare database.',
                detail: 'Please check the console log for details.',
                showOk: true,
                okLabel: 'OK',
            });
            return;
        }

        // ── MPL member count AFTER ipod_write_db ──
        {
            const trackCountAfter = wasm.wasmCall('ipod_get_track_count');
            const plsAfter = wasm.wasmGetJson('ipod_get_all_playlists_json');
            const mplAfter = plsAfter?.find(p => p.is_master);
            console.log(`[SyncDiag] MPL member count AFTER ipod_write_db: ${mplAfter?.track_count ?? '?'} (track list: ${trackCountAfter})`);
            if (mplAfter && mplAfter.track_count !== trackCountAfter) {
                log?.(`⚠ MPL/track MISMATCH after write: MPL=${mplAfter.track_count}, tracks=${trackCountAfter}`, 'warning');
            }
        }

        // Verify: parse the MEMFS iTunesDB binary — enumerate ALL mhsd sections
        try {
            const FS = wasm.getModule().FS;
            const dbPath = `${fsSync.mountpoint}/iPod_Control/iTunes/iTunesDB`;
            const written = FS.readFile(dbPath);
            const wView = new DataView(written.buffer, written.byteOffset, written.byteLength);
            let diskTrackCount = 0;
            if (written.length > 0x20) {
                const mhbdHL = wView.getUint32(4, true);
                const dbVersion = wView.getUint32(0x10, true);
                const numChildren = wView.getUint32(0x14, true);
                const dbIdHex = Array.from(written.slice(0x18, 0x20)).map(b => b.toString(16).padStart(2, '0')).join('');
                const hashScheme = wView.getUint16(0x30, true);
                log?.(`mhbd: hdr=${mhbdHL}, version=${dbVersion}, children=${numChildren}, db_id=0x${dbIdHex}, scheme=${hashScheme}`, 'info');

                // Walk ALL mhsd sections
                let p = mhbdHL;
                let sectionsFound = 0;
                for (let i = 0; i < numChildren && p + 16 <= written.length; i++) {
                    const tag = String.fromCharCode(written[p], written[p+1], written[p+2], written[p+3]);
                    if (tag !== 'mhsd') break;
                    const sHL = wView.getUint32(p + 4, true);
                    const sTL = wView.getUint32(p + 8, true);
                    const sType = wView.getUint32(p + 0x0C, true);
                    sectionsFound++;

                    // Peek at the child header inside this mhsd
                    const childP = p + sHL;
                    let childInfo = '';
                    if (childP + 12 <= written.length) {
                        const childTag = String.fromCharCode(written[childP], written[childP+1], written[childP+2], written[childP+3]);
                        const childHL = wView.getUint32(childP + 4, true);
                        const childCount = wView.getUint32(childP + 8, true);
                        childInfo = ` → ${childTag} (count=${childCount})`;

                        if (sType === 1 && childTag === 'mhlt') {
                            diskTrackCount = childCount;
                        }

                        // For playlist sections: peek at the first playlist (MPL)
                        if (childTag === 'mhlp' && childCount > 0) {
                            const firstPlP = childP + childHL;
                            if (firstPlP + 24 <= written.length) {
                                const plTag = String.fromCharCode(written[firstPlP], written[firstPlP+1], written[firstPlP+2], written[firstPlP+3]);
                                if (plTag === 'mhyp') {
                                    const plMembers = wView.getUint32(firstPlP + 16, true);
                                    const plFlag = wView.getUint8(firstPlP + 20);
                                    childInfo += `, MPL: ${plMembers} members (flag=${plFlag})`;
                                }
                            }
                        }
                    }

                    log?.(`  mhsd #${i}: type=${sType}, size=${sTL}${childInfo}`, 'info');
                    p += sTL;
                }
                log?.(`iTunesDB: ${diskTrackCount} tracks, ${written.length} bytes, ${sectionsFound}/${numChildren} sections`, 'info');

                // Log libgpod's hash58 for reference (no longer overridden by JS)
                if (hashScheme === 1 && written.length > 0x6C) {
                    const libgpodHash = Array.from(written.slice(0x58, 0x6C))
                        .map(b => b.toString(16).padStart(2, '0')).join('');
                    log?.(`libgpod hash58: ${libgpodHash} (will be preserved as-is)`, 'info');
                }
            }

            // List all files libgpod generated and clean stale ones
            const itunesDir = `${fsSync.mountpoint}/iPod_Control/iTunes`;
            const files = FS.readdir(itunesDir).filter(n => n !== '.' && n !== '..');
            log?.(`MEMFS files after write: ${files.join(', ')}`, 'info');

            // itdb_write() renames "Play Counts" → "Play Counts.bak".
            // Remove it immediately so it doesn't confuse a later ipod_parse_db().
            for (const stale of ['Play Counts', 'Play Counts.bak', 'OTGPlaylistInfo']) {
                try { FS.unlink(`${itunesDir}/${stale}`); } catch (_) {}
            }
        } catch (e) {
            console.warn('[SyncDiag] Could not verify iTunesDB:', e);
        }

        // 2b) Re-sign hashAB databases (Nano 6G/7G only).
        //     Hash58 (Nano 3G/4G, Classic) is handled in step 2d below,
        //     AFTER all database modifications (artwork patch etc.) are done.
        {
            // hashAB — Nano 6G/7G (iTunesCDB + Locations.itdb.cbk)
            if (firewireSetup?.needsHashAB?.()) {
                const fwGuid = firewireSetup.getFirewireGuidHex();
                if (fwGuid) {
                    try {
                        await fsSync.reSignDatabaseFiles(fwGuid);
                    } catch (e) {
                        log?.(`hashAB re-sign failed: ${e?.message || e}`, 'warning');
                    }
                }
            }
        }

        // 2c) Generate and write ArtworkDB + .ithmb files (pure JS, bypasses WASM)
        //
        // IMPORTANT: We must merge NEW artwork entries with EXISTING entries already
        // on the iPod. Otherwise, syncing a single new track would overwrite the
        // ArtworkDB and erase artwork for all previously synced tracks.
        const hasPendingDeletes = (appState.pendingFileDeletes?.length || 0) > 0;
        if (artworkEntries.length > 0 || hasPendingDeletes) {
            try {
                setUploadModalState({ status: 'Generating artwork...', detail: '' });

                // ── Read existing artwork from iPod ──────────────────────────
                let existingArtworkEntries = [];
                try {
                    const { artworkDb: existingDb, ithmbs: existingIthmbs } = await fsSync.readArtworkFromIpod(appState.ipodHandle);
                    if (existingDb && existingDb.length > 0) {
                        const parsed = parseExistingArtworkDb(existingDb);
                        for (const entry of parsed) {
                            const preRendered = new Map();
                            for (const thumb of entry.thumbnails) {
                                const filename = `F${thumb.formatId}_1.ithmb`;
                                const itmbData = existingIthmbs.get(filename);
                                if (itmbData && thumb.itmbOffset + thumb.imgSize <= itmbData.length) {
                                    preRendered.set(
                                        thumb.formatId,
                                        itmbData.slice(thumb.itmbOffset, thumb.itmbOffset + thumb.imgSize),
                                    );
                                }
                            }
                            if (preRendered.size > 0) {
                                existingArtworkEntries.push({
                                    dbid: entry.dbid,       // BigInt (exact)
                                    preRendered,
                                    origSize: entry.origSize,
                                });
                            }
                        }
                        log?.(`Found ${existingArtworkEntries.length} existing artwork entry/ies on iPod`, 'info');
                    }
                } catch (e) {
                    log?.(`Could not read existing artwork: ${e?.message || e}`, 'warning');
                }

                // ── Determine artwork formats ────────────────────────────────

                // Tier 1: SysInfoExtended from MEMFS or iPod
                let plistXml = fsSync.readSysInfoExtendedFromVFS();
                if (!plistXml && appState.ipodHandle) {
                    try {
                        const ctrl = await appState.ipodHandle.getDirectoryHandle('iPod_Control', { create: false });
                        const dev = await ctrl.getDirectoryHandle('Device', { create: false });
                        const fh = await dev.getFileHandle('SysInfoExtended', { create: false });
                        const file = await fh.getFile();
                        plistXml = await file.text();
                        log?.('Read SysInfoExtended directly from iPod', 'info');
                    } catch (_) {}
                }

                let formats = plistXml ? parseAlbumArtFormats(plistXml) : [];
                if (formats.length > 0) {
                    log?.(`SysInfoExtended: ${formats.length} format(s) — ${formats.map(f => `${f.formatId}:${f.width}x${f.height}`).join(', ')}`, 'info');
                }

                // Tier 2: detect from existing .ithmb files on iPod
                if (formats.length === 0 && appState.ipodHandle) {
                    try {
                        const existingIds = await fsSync.scanExistingIthmbs(appState.ipodHandle);
                        if (existingIds.length > 0) {
                            formats = lookupFormatSpecs(existingIds);
                            if (formats.length > 0) {
                                log?.(`Detected formats from existing ithmb files: ${formats.map(f => `${f.formatId}:${f.width}x${f.height}`).join(', ')}`, 'info');
                            } else {
                                log?.(`Found ithmb files for format IDs [${existingIds.join(', ')}] but no matching specs — using fallback`, 'warning');
                            }
                        }
                    } catch (_) {}
                }

                // Tier 3: broad fallback covering multiple iPod generations
                if (formats.length === 0) {
                    formats = [
                        { formatId: 1028, width: 100, height: 100, crop: false }, // iPod Video (5G)
                        { formatId: 1029, width: 200, height: 200, crop: false }, // iPod Video (5G)
                        { formatId: 1061, width:  56, height:  56, crop: false }, // Classic / Nano 3G
                        { formatId: 1055, width: 128, height: 128, crop: false }, // Classic / Nano 3G-4G
                        { formatId: 1060, width: 320, height: 320, crop: false }, // Classic / Nano 3G-4G
                    ];
                    log?.(`Using broad fallback artwork formats: ${formats.map(f => `${f.formatId}:${f.width}x${f.height}`).join(', ')}`, 'info');
                }

                // Nano 3G completeness: if we have 1055 or 1060 but are missing 1061
                // (56×56 list thumbnail), add it.  The iPod firmware expects all three
                // formats; a missing 1061 can cause artwork to not display at all.
                {
                    const ids = new Set(formats.map(f => f.formatId));
                    if ((ids.has(1055) || ids.has(1060)) && !ids.has(1061)) {
                        formats.unshift({ formatId: 1061, width: 56, height: 56, crop: false });
                        log?.('Added missing format 1061 (56×56) for Nano 3G completeness', 'info');
                    }
                }

                if (formats.length > 0) {
                    // ── Extract current track dbids (exact BigInts) ───────────
                    // Read the iTunesDB binary to get exact 64-bit dbids for all
                    // current tracks. Used for: (1) fixing precision of new entries,
                    // (2) filtering out artwork for deleted tracks.
                    let currentTrackDbids = new Set(); // Set<BigInt>
                    let dbSnapshot = null;
                    try {
                        const FS = wasm.getModule().FS;
                        const dbPath = `${fsSync.mountpoint}/iPod_Control/iTunes/iTunesDB`;
                        const rawData = FS.readFile(dbPath);
                        dbSnapshot = new Uint8Array(rawData.length);
                        dbSnapshot.set(rawData);

                        // Walk mhlt to extract all track dbids as BigInts
                        const sv = new DataView(dbSnapshot.buffer, dbSnapshot.byteOffset, dbSnapshot.byteLength);
                        const mhbdHL = sv.getUint32(4, true);
                        const numCh = sv.getUint32(0x14, true);
                        let sp = mhbdHL;
                        for (let si = 0; si < numCh && sp + 16 <= dbSnapshot.length; si++) {
                            const st = String.fromCharCode(dbSnapshot[sp], dbSnapshot[sp+1], dbSnapshot[sp+2], dbSnapshot[sp+3]);
                            if (st !== 'mhsd') break;
                            const sType = sv.getUint32(sp + 0x0C, true);
                            const sHL = sv.getUint32(sp + 4, true);
                            const sTL = sv.getUint32(sp + 8, true);
                            if (sType === 1) {
                                const mhltP = sp + sHL;
                                const mhltHL = sv.getUint32(mhltP + 4, true);
                                const nTracks = sv.getUint32(mhltP + 8, true);
                                let tp = mhltP + mhltHL;
                                for (let t = 0; t < nTracks && tp + 4 <= dbSnapshot.length; t++) {
                                    const tt = String.fromCharCode(dbSnapshot[tp], dbSnapshot[tp+1], dbSnapshot[tp+2], dbSnapshot[tp+3]);
                                    if (tt !== 'mhit') break;
                                    const mhitHL = sv.getUint32(tp + 4, true);
                                    const mhitTL = sv.getUint32(tp + 8, true);
                                    if (mhitHL > 0x78) {
                                        currentTrackDbids.add(sv.getBigUint64(tp + 0x70, true));
                                    }
                                    tp += mhitTL;
                                }
                                break;
                            }
                            sp += sTL;
                        }
                        log?.(`Extracted ${currentTrackDbids.size} current track dbid(s) from iTunesDB`, 'info');
                    } catch (e) {
                        log?.(`Could not extract current dbids: ${e?.message || e}`, 'warning');
                    }

                    // ── Fix dbid precision for NEW entries ────────────────────
                    if (artworkEntries.length > 0 && dbSnapshot) {
                        const newNumberDbids = artworkEntries.map(ae => ae.dbid);
                        try {
                            const exactDbids = extractExactDbids(dbSnapshot, newNumberDbids);
                            if (exactDbids.size > 0) {
                                for (const ae of artworkEntries) {
                                    const exact = exactDbids.get(ae.dbid);
                                    if (exact !== undefined) {
                                        log?.(`dbid fix: ${ae.dbid} (0x${ae.dbid.toString(16)}) → 0x${exact.toString(16)}`, 'info');
                                        ae.dbid = exact;
                                    }
                                }
                                log?.(`Fixed ${exactDbids.size} dbid(s) with exact 64-bit values from iTunesDB`, 'info');
                            }
                        } catch (e) {
                            log?.(`dbid precision fix failed (artwork may not link): ${e?.message || e}`, 'warning');
                        }
                    }

                    // ── Merge existing + new artwork entries ──────────────────
                    // 1. New entries override existing ones with same dbid
                    // 2. Existing entries for DELETED tracks are removed (orphan cleanup)
                    // 3. Remaining existing entries are kept
                    const newDbidSet = new Set(artworkEntries.map(ae =>
                        typeof ae.dbid === 'bigint' ? ae.dbid : BigInt(ae.dbid)));
                    const beforeFilter = existingArtworkEntries.length;
                    const keptExisting = existingArtworkEntries.filter(e =>
                        !newDbidSet.has(e.dbid) &&
                        (currentTrackDbids.size === 0 || currentTrackDbids.has(e.dbid)));
                    const mergedEntries = [...keptExisting, ...artworkEntries];
                    const removedCount = beforeFilter - keptExisting.length;
                    if (removedCount > 0) {
                        log?.(`Artwork cleanup: removed ${removedCount} entry/ies (overridden or orphaned from deleted tracks)`, 'info');
                    }
                    log?.(`Artwork merge: ${keptExisting.length} existing + ${artworkEntries.length} new = ${mergedEntries.length} total`, 'info');
                    log?.(`Generating artwork for ${mergedEntries.length} track(s) in ${formats.length} format(s)...`, 'info');

                    const { artworkDb, ithmbs } = await generateArtworkFiles(mergedEntries, formats, ({ current, total, detail }) => {
                        setUploadModalState({ status: 'Generating artwork...', detail: detail || `${current}/${total}` });
                    });

                    if (artworkDb.length > 0) {
                        setUploadModalState({ status: 'Writing artwork to iPod...', detail: '' });
                        await fsSync.writeArtworkFiles(appState.ipodHandle, artworkDb, ithmbs);
                        log?.(`Wrote artwork: ArtworkDB + ${ithmbs.size} .ithmb file(s)`, 'success');

                        // ── DISABLED: iTunesDB artwork patching ──────────────
                        // Patching has_artwork / artwork_count / artwork_size in
                        // MHIT records modifies the database binary AFTER libgpod's
                        // itdb_write(), which invalidates libgpod's hash58.  Our JS
                        // hash58 recomputation does not match libgpod's, so the iPod
                        // rejects the modified database.  Skipping this keeps
                        // libgpod's hash58 intact.  Artwork in ArtworkDB/ithmb is
                        // still written (separate files); tracks just won't display
                        // cover art until we fix hash58 or expose libgpod's hash
                        // function via WASM.
                        log?.(`Artwork files written; iTunesDB artwork flags NOT patched (preserving libgpod hash58)`, 'info');
                    }
                }
            } catch (e) {
                log?.(`Artwork generation failed: ${e?.message || e}`, 'warning');
            }
        }

        // 2d) Use libgpod's hash58 AS-IS — no modifications to iTunesDB.
        //
        //     Our JavaScript recomputeHash58() produces a DIFFERENT HMAC-SHA1
        //     than libgpod's C code (confirmed by diagnostic: neither BE nor LE
        //     byte order for FWID matches).  ANY modification to the database
        //     after itdb_write() (db_id randomization, artwork patching, hash58
        //     recomputation) invalidates the correct hash that libgpod wrote.
        //
        //     Strategy: ship libgpod's database UNMODIFIED.  The iPod will
        //     accept it because the hash matches.  Artwork flags won't be set
        //     in iTunesDB (cover art won't display), but tracks WILL appear
        //     with correct counts.
        //
        //     TODO: Fix JS hash58 key derivation to match libgpod, OR expose
        //     libgpod's hash computation via WASM so we can re-sign after mods.
        {
            try {
                const FS = wasm.getModule().FS;
                const dbPath = `${fsSync.mountpoint}/iPod_Control/iTunes/iTunesDB`;
                const dbData = FS.readFile(dbPath);

                // Log final database state (read-only, no modifications)
                if (dbData.length > 0x20) {
                    const view = new DataView(dbData.buffer, dbData.byteOffset, dbData.byteLength);
                    const mhbdHL = view.getUint32(4, true);
                    const nChildren = view.getUint32(0x14, true);
                    const scheme = dbData.length > 0x32 ? (dbData[0x30] | (dbData[0x31] << 8)) : 0;
                    const finalDbId = Array.from(dbData.slice(0x18, 0x20)).map(b => b.toString(16).padStart(2, '0')).join('');
                    const finalHash58 = Array.from(dbData.slice(0x58, 0x6C)).map(b => b.toString(16).padStart(2, '0')).join('');
                    log?.(`Final database (libgpod, unmodified): ${dbData.length} bytes, ${nChildren} sections, db_id=0x${finalDbId}, scheme=${scheme}`, 'info');
                    log?.(`hash58 (libgpod): ${finalHash58}`, 'info');
                    let p = mhbdHL;
                    for (let i = 0; i < nChildren && p + 16 <= dbData.length; i++) {
                        const tag = String.fromCharCode(dbData[p], dbData[p+1], dbData[p+2], dbData[p+3]);
                        if (tag !== 'mhsd') break;
                        const sType = view.getUint32(p + 0x0C, true);
                        const sHL = view.getUint32(p + 4, true);
                        const sTL = view.getUint32(p + 8, true);
                        const childP = p + sHL;
                        let childInfo = '';
                        if (childP + 12 <= dbData.length) {
                            const cTag = String.fromCharCode(dbData[childP], dbData[childP+1], dbData[childP+2], dbData[childP+3]);
                            const cCount = view.getUint32(childP + 8, true);
                            childInfo = ` → ${cTag}(${cCount})`;
                        }
                        log?.(`  mhsd #${i}: type=${sType}, size=${sTL}${childInfo}`, 'info');
                        p += sTL;
                    }
                }
            } catch (e) {
                log?.(`Database verification failed: ${e?.message || e}`, 'warning');
            }
        }

        // 3) Copy iTunesDB (+ optional iTunesSD) to iPod, then apply deletions
        try {
            setUploadModalState({ status: 'Uploading to iPod...', detail: '', percent: 0 });
            const res = await fsSync.syncDbToIpod(appState.ipodHandle, {
                onProgress: ({ percent, detail }) => {
                    setUploadModalState({
                        title: 'Syncing to iPod...',
                        status: 'Syncing to iPod...',
                        detail: detail || '',
                        percent,
                        showOk: false,
                    });
                }
            });

            if (!res?.ok) {
                setUploadModalState({
                    title: 'Upload finished with errors',
                    status: 'Some files could not be uploaded.',
                    detail: 'Please check the console log for details.',
                    percent: 100,
                    showOk: true,
                    okLabel: 'OK',
                });
                return;
            }

            // ── Verify: read back iTunesDB from iPod and check track count ──
            try {
                const ctrl = await appState.ipodHandle.getDirectoryHandle('iPod_Control', { create: false });
                const itDir = await ctrl.getDirectoryHandle('iTunes', { create: false });
                const fh = await itDir.getFileHandle('iTunesDB', { create: false });
                const readBack = await fh.getFile();
                const rbData = new Uint8Array(await readBack.arrayBuffer());
                const rbView = new DataView(rbData.buffer);
                let rbTrackCount = -1;
                if (rbData.length > 0x20 && String.fromCharCode(rbData[0], rbData[1], rbData[2], rbData[3]) === 'mhbd') {
                    const mhbdHL = rbView.getUint32(4, true);
                    const numCh = rbView.getUint32(0x14, true);  // children at 0x14
                    let p = mhbdHL;
                    for (let i = 0; i < numCh && p + 16 <= rbData.length; i++) {
                        const tag = String.fromCharCode(rbData[p], rbData[p+1], rbData[p+2], rbData[p+3]);
                        if (tag !== 'mhsd') break;
                        const sType = rbView.getUint32(p + 0x0C, true);
                        const sHL = rbView.getUint32(p + 4, true);
                        const sTL = rbView.getUint32(p + 8, true);
                        if (sType === 1) {
                            rbTrackCount = rbView.getUint32(p + sHL + 8, true);
                        }
                        p += sTL;
                    }
                }
                const rbDbId = rbData.length >= 0x20 ? Array.from(rbData.slice(0x18, 0x20)).map(b => b.toString(16).padStart(2, '0')).join('') : '?';
                const rbHash58 = rbData.length >= 0x6C ? Array.from(rbData.slice(0x58, 0x6C)).map(b => b.toString(16).padStart(2, '0')).join('') : '?';
                log?.(`Read-back: iPod iTunesDB = ${rbData.length} bytes, ${rbTrackCount} tracks, db_id=0x${rbDbId}`, rbTrackCount >= 0 ? 'info' : 'warning');
                log?.(`Read-back hash58: ${rbHash58}`, 'info');

                // List all files in iPod_Control/iTunes/ on the real iPod
                const realFiles = [];
                for await (const [name] of itDir.entries()) {
                    realFiles.push(name);
                }
                log?.(`Files on iPod: ${realFiles.join(', ')}`, 'info');
            } catch (e) {
                log?.(`Read-back verification failed: ${e?.message || e}`, 'warning');
            }

            const pendingDeletes = appState.pendingFileDeletes || [];
            if (pendingDeletes.length > 0) {
                for (const relFsPath of pendingDeletes) {
                    try {
                        await fsSync.deleteFileFromIpodRelativePath(appState.ipodHandle, relFsPath);
                        log?.(`Deleted file: ${relFsPath}`, 'info');
                    } catch (e) {
                        log?.(`Could not delete file: ${relFsPath} (${e?.message || e})`, 'warning');
                    }
                }
            }
        } catch (e) {
            log?.(`Sync failed: ${e?.message || e}`, 'error');
            setUploadModalState({
                title: 'Upload failed',
                status: 'Uploading to iPod failed.',
                detail: 'Please check the console log for details.',
                showOk: true,
                okLabel: 'OK',
            });
            return;
        }

        appState.pendingUploads = [];
        appState.pendingFileDeletes = [];

        await refreshCurrentView();
        log?.('Sync complete', 'success');

        setUploadModalState({
            title: 'Done syncing!',
            status: 'Done syncing! Safe to disconnect.',
            detail: '',
            percent: 100,
            showOk: true,
            okLabel: 'OK',
        });
    }

    return {
        saveDatabase,
        dismissUploadModal,
        setUploadModalState,
    };
}
