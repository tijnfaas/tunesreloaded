import { parseAlbumArtFormats, generateArtworkFiles, patchITunesDbArtwork, lookupFormatSpecs, debugPreviewIthmb, extractExactDbids } from './artworkWriter.js';
import { recomputeHash58, parseUUID } from './hashAB.js';

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

        // Verify: count tracks in the MEMFS iTunesDB that was just written
        try {
            const FS = wasm.getModule().FS;
            const dbPath = `${fsSync.mountpoint}/iPod_Control/iTunes/iTunesDB`;
            const written = FS.readFile(dbPath);
            const wView = new DataView(written.buffer, written.byteOffset, written.byteLength);
            // mhbd → skip to mhsd type=1 → mhlt → numTracks
            if (written.length > 0x20) {
                const mhbdHL = wView.getUint32(4, true);
                let p = mhbdHL;
                const nMhsd = wView.getUint32(0x10, true);
                for (let i = 0; i < nMhsd && p + 16 <= written.length; i++) {
                    const sType = wView.getUint32(p + 0x0C, true);
                    const sHL = wView.getUint32(p + 4, true);
                    const sTL = wView.getUint32(p + 8, true);
                    if (sType === 1) {
                        const mhltP = p + sHL;
                        const nTracks = wView.getUint32(mhltP + 8, true);
                        log?.(`iTunesDB written: ${nTracks} tracks, ${written.length} bytes`, 'info');
                        console.log(`[SyncDiag] iTunesDB on disk: ${nTracks} tracks, ${written.length} bytes`);
                        break;
                    }
                    p += sTL;
                }
            }
        } catch (e) {
            console.warn('[SyncDiag] Could not verify iTunesDB:', e);
        }

        // 2b) Re-sign iTunesCDB + Locations.itdb.cbk with the standalone hashAB WASM
        //     Only Nano 6th/7th gen use hashAB signing.
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

        // 2c) Generate and write ArtworkDB + .ithmb files (pure JS, bypasses WASM)
        if (artworkEntries.length > 0) {
            try {
                setUploadModalState({ status: 'Generating artwork...', detail: '' });

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
                    // ── Fix dbid precision ──────────────────────────────────────
                    // JavaScript Numbers (64-bit double) can only represent integers
                    // up to 2^53 exactly. iPod dbids are random 64-bit values, so
                    // JSON.parse rounds them. We read the exact BigInt values from
                    // the iTunesDB binary before generating ArtworkDB.
                    const numberDbids = artworkEntries.map(ae => ae.dbid); // save imprecise Numbers for iTunesDB patching
                    try {
                        const FS = wasm.getModule().FS;
                        const dbPath = `${fsSync.mountpoint}/iPod_Control/iTunes/iTunesDB`;
                        const rawData = FS.readFile(dbPath);
                        const dbSnapshot = new Uint8Array(rawData.length);
                        dbSnapshot.set(rawData);

                        const exactDbids = extractExactDbids(dbSnapshot, numberDbids);
                        if (exactDbids.size > 0) {
                            for (const ae of artworkEntries) {
                                const exact = exactDbids.get(ae.dbid);
                                if (exact !== undefined) {
                                    log?.(`dbid fix: ${ae.dbid} (0x${ae.dbid.toString(16)}) → 0x${exact.toString(16)}`, 'info');
                                    ae.dbid = exact; // Replace imprecise Number with exact BigInt
                                }
                            }
                            log?.(`Fixed ${exactDbids.size} dbid(s) with exact 64-bit values from iTunesDB`, 'info');
                        }
                    } catch (e) {
                        log?.(`dbid precision fix failed (artwork may not link): ${e?.message || e}`, 'warning');
                    }

                    log?.(`Generating artwork for ${artworkEntries.length} track(s) in ${formats.length} format(s)...`, 'info');
                    const { artworkDb, ithmbs } = await generateArtworkFiles(artworkEntries, formats, ({ current, total, detail }) => {
                        setUploadModalState({ status: 'Generating artwork...', detail: detail || `${current}/${total}` });
                    });

                    if (artworkDb.length > 0) {
                        // ── Verify ArtworkDB song_id bytes ──
                        // Dump the mhii song_id (offset 0x14 from mhii start) to verify
                        // that the BigInt dbid was written correctly.
                        try {
                            const MHFD = 0x84, MHSD = 0x60, MHLI = 0x5C;
                            const mhiiStart = MHFD + MHSD + MHLI;
                            if (artworkDb.length >= mhiiStart + 0x1C) {
                                const songIdBytes = Array.from(artworkDb.slice(mhiiStart + 0x14, mhiiStart + 0x1C))
                                    .map(b => b.toString(16).padStart(2, '0')).join(' ');
                                const artDbView = new DataView(artworkDb.buffer, artworkDb.byteOffset, artworkDb.byteLength);
                                const songIdBig = artDbView.getBigUint64(mhiiStart + 0x14, true);
                                console.log(`[ArtworkVerify] ArtworkDB mhii song_id: 0x${songIdBig.toString(16)} bytes=[${songIdBytes}]`);
                                // Compare with what we intended
                                const intended = artworkEntries[0]?.dbid;
                                const match = (typeof intended === 'bigint') ? (songIdBig === intended) : (songIdBig === BigInt(intended));
                                console.log(`[ArtworkVerify] Intended dbid: 0x${intended?.toString(16)} — ${match ? '✓ MATCH' : '✗ MISMATCH!'}`);
                            }
                        } catch (e) {
                            console.warn('[ArtworkVerify] Verification failed:', e);
                        }

                        setUploadModalState({ status: 'Writing artwork to iPod...', detail: '' });
                        await fsSync.writeArtworkFiles(appState.ipodHandle, artworkDb, ithmbs);
                        log?.(`Wrote artwork: ArtworkDB + ${ithmbs.size} .ithmb file(s)`, 'success');

                        // Patch iTunesDB in MEMFS: set has_artwork / artwork_count / artwork_size
                        try {
                            const FS = wasm.getModule().FS;
                            const dbPath = `${fsSync.mountpoint}/iPod_Control/iTunes/iTunesDB`;
                            // Use saved Number dbids (not the BigInt-fixed ones) for iTunesDB patching,
                            // because patchITunesDbArtwork reads dbids as Numbers too.
                            const artworkDbids = new Set(numberDbids);
                            const ithmbSizePerTrack = formats.reduce((sum, f) => sum + f.width * f.height * 2, 0);

                            console.log(`[ArtworkDiag] Patching iTunesDB: ${artworkEntries.length} artwork entry/ies, numberDbids=[${numberDbids.map(d => '0x' + d.toString(16)).join(', ')}]`);

                            // CRITICAL: FS.readFile may return the internal MEMFS buffer.
                            // We must copy it to our own ArrayBuffer before modifying,
                            // otherwise FS.writeFile triggers a use-after-free.
                            const rawData = FS.readFile(dbPath);
                            const dbData = new Uint8Array(rawData.length);
                            dbData.set(rawData);

                            const { patched } = patchITunesDbArtwork(dbData, artworkDbids, formats.length, ithmbSizePerTrack);
                            if (patched > 0) {
                                // Recompute hash58 if this device uses checksum type 1 (Nano 3G/4G, Classic 6G/7G).
                                // Our binary patch invalidates the HMAC-SHA1 checksum that ipod_write_db() computed.
                                const scheme = dbData[0x30] | (dbData[0x31] << 8);
                                if (scheme === 1) {
                                    const fwGuid = firewireSetup?.getFirewireGuidHex();
                                    if (fwGuid) {
                                        try {
                                            await recomputeHash58(dbData, parseUUID(fwGuid));
                                            log?.('Recomputed iTunesDB hash58 after artwork patch', 'info');
                                        } catch (e) {
                                            log?.(`hash58 recomputation failed: ${e?.message || e}`, 'warning');
                                        }
                                    } else {
                                        log?.('No FirewireGuid available — hash58 not recomputed (database may be rejected by iPod)', 'warning');
                                    }
                                }

                                FS.writeFile(dbPath, dbData);
                                log?.(`Patched iTunesDB: ${patched} track(s) marked with artwork`, 'info');
                            } else {
                                log?.('iTunesDB patch: no matching tracks found (dbid mismatch?)', 'warning');
                            }
                        } catch (e) {
                            log?.(`iTunesDB artwork patch failed: ${e?.message || e}`, 'warning');
                        }
                    }
                }
            } catch (e) {
                log?.(`Artwork generation failed: ${e?.message || e}`, 'warning');
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
