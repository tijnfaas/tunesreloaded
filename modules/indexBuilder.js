/**
 * indexBuilder.js — Generate iPod database index sections (mhsd types 4, 8)
 *
 * After libgpod's itdb_write(), the track list (type 1) and playlists (type 2, 3)
 * are correct, but the album index (type 4) and artist index (type 8) are stale.
 * The iPod firmware reads these index sections for its Music browser — stale data
 * causes it to show wrong track/album/artist counts.
 *
 * This module strips the old index sections, regenerates types 4 and 8 from the
 * current track data, patches each MHIT record with the correct album_id and
 * artist_id cross-references, and appends empty stubs for types 5, 6, 10.
 *
 * Binary format based on iOpenPod (github.com/TheRealSavi/iOpenPod).
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write a 4-char ASCII tag at offset in buffer */
function writeTag(buf, offset, tag) {
    for (let i = 0; i < 4; i++) buf[offset + i] = tag.charCodeAt(i);
}

/** Encode a JS string as UTF-16LE bytes */
function encodeUtf16LE(str) {
    const buf = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        buf[i * 2] = code & 0xFF;
        buf[i * 2 + 1] = (code >> 8) & 0xFF;
    }
    return buf;
}

/** Concatenate multiple Uint8Arrays */
function concatBuffers(buffers) {
    const totalLen = buffers.reduce((s, b) => s + b.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of buffers) {
        result.set(buf, offset);
        offset += buf.length;
    }
    return result;
}

/** Generate a random non-zero 64-bit value (for sql_id fields) */
function randomSqlId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    if (bytes.every(b => b === 0)) bytes[0] = 1;
    return bytes;
}


// ── MHOD string builder ────────────────────────────────────────────────────

/**
 * Build an MHOD string entry (used for album/artist names).
 *
 * Layout:
 *   Header (24 bytes): magic, header_len=24, total_len, type, padding
 *   String block (16 + utf16 bytes): position=1, byte_len, unk=1, unk=0, data
 *
 * @param {number} type - MHOD type (200 = album name, 300 = artist name)
 * @param {string} text - The string value
 * @returns {Uint8Array}
 */
function buildMhodString(type, text) {
    const utf16 = encodeUtf16LE(text || '');
    const headerLen = 24;
    const stringBlockLen = 16 + utf16.length;
    const totalLen = headerLen + stringBlockLen;

    const buf = new Uint8Array(totalLen);
    const v = new DataView(buf.buffer);

    writeTag(buf, 0, 'mhod');
    v.setUint32(4, headerLen, true);
    v.setUint32(8, totalLen, true);
    v.setUint32(12, type, true);
    // bytes 16–23: zero padding (already zero)

    const sb = headerLen;
    v.setUint32(sb + 0, 1, true);            // position = 1
    v.setUint32(sb + 4, utf16.length, true);  // string_byte_length
    v.setUint32(sb + 8, 1, true);             // unk = 1
    v.setUint32(sb + 12, 0, true);            // unk = 0
    buf.set(utf16, sb + 16);

    return buf;
}


// ── Album items (MHIA) ─────────────────────────────────────────────────────

/**
 * Build an MHIA (album item) entry.
 *
 * Header: 88 bytes
 *   +0x00 'mhia', +0x04 header_len=88, +0x08 total_len,
 *   +0x0C child_count, +0x10 album_id, +0x14 sql_id(8B), +0x1C unk3=2
 * Children: MHOD type 200 (album name)
 */
function buildMhia(albumId, albumName) {
    const HEADER_LEN = 88;
    const mhod = buildMhodString(200, albumName);
    const totalLen = HEADER_LEN + mhod.length;

    const buf = new Uint8Array(totalLen);
    const v = new DataView(buf.buffer);

    writeTag(buf, 0, 'mhia');
    v.setUint32(4, HEADER_LEN, true);
    v.setUint32(8, totalLen, true);
    v.setUint32(12, 1, true);            // 1 MHOD child
    v.setUint32(16, albumId, true);      // album_id
    buf.set(randomSqlId(), 0x14);        // sql_id (8 bytes)
    v.setUint32(0x1C, 2, true);          // unk3 = 2

    buf.set(mhod, HEADER_LEN);
    return buf;
}


// ── Artist items (MHII) ────────────────────────────────────────────────────

/**
 * Build an MHII (artist item) entry.
 *
 * Header: 80 bytes
 *   +0x00 'mhii', +0x04 header_len=80, +0x08 total_len,
 *   +0x0C child_count, +0x10 artist_id, +0x14 sql_id(8B), +0x1C unk3=2
 * Children: MHOD type 300 (artist name)
 */
function buildMhii(artistId, artistName) {
    const HEADER_LEN = 80;
    const mhod = buildMhodString(300, artistName);
    const totalLen = HEADER_LEN + mhod.length;

    const buf = new Uint8Array(totalLen);
    const v = new DataView(buf.buffer);

    writeTag(buf, 0, 'mhii');
    v.setUint32(4, HEADER_LEN, true);
    v.setUint32(8, totalLen, true);
    v.setUint32(12, 1, true);            // 1 MHOD child
    v.setUint32(16, artistId, true);     // artist_id
    buf.set(randomSqlId(), 0x14);        // sql_id (8 bytes)
    v.setUint32(0x1C, 2, true);          // unk3 = 2

    buf.set(mhod, HEADER_LEN);
    return buf;
}


// ── MHSD section containers ────────────────────────────────────────────────

/**
 * Build MHSD type 4: Album List (mhla + mhia entries).
 *
 * @param {Array<{id: number, name: string}>} albums
 * @returns {Uint8Array}
 */
function buildAlbumSection(albums) {
    const MHSD_HL = 96;
    const MHLA_HL = 92;

    // MHLA header
    const mhlaHeader = new Uint8Array(MHLA_HL);
    const mv = new DataView(mhlaHeader.buffer);
    writeTag(mhlaHeader, 0, 'mhla');
    mv.setUint32(4, MHLA_HL, true);
    mv.setUint32(8, albums.length, true);

    // All MHIA entries
    const parts = [mhlaHeader];
    for (const album of albums) {
        parts.push(buildMhia(album.id, album.name));
    }
    const childData = concatBuffers(parts);

    // MHSD wrapper
    const mhsd = new Uint8Array(MHSD_HL);
    const sv = new DataView(mhsd.buffer);
    writeTag(mhsd, 0, 'mhsd');
    sv.setUint32(4, MHSD_HL, true);
    sv.setUint32(8, MHSD_HL + childData.length, true);
    sv.setUint32(12, 4, true);           // dataset_type = 4

    return concatBuffers([mhsd, childData]);
}

/**
 * Build MHSD type 8: Artist List (mhli + mhii entries).
 *
 * @param {Array<{id: number, name: string}>} artists
 * @returns {Uint8Array}
 */
function buildArtistSection(artists) {
    const MHSD_HL = 96;
    const MHLI_HL = 92;

    // MHLI header
    const mhliHeader = new Uint8Array(MHLI_HL);
    const mv = new DataView(mhliHeader.buffer);
    writeTag(mhliHeader, 0, 'mhli');
    mv.setUint32(4, MHLI_HL, true);
    mv.setUint32(8, artists.length, true);

    // All MHII entries
    const parts = [mhliHeader];
    for (const artist of artists) {
        parts.push(buildMhii(artist.id, artist.name));
    }
    const childData = concatBuffers(parts);

    // MHSD wrapper
    const mhsd = new Uint8Array(MHSD_HL);
    const sv = new DataView(mhsd.buffer);
    writeTag(mhsd, 0, 'mhsd');
    sv.setUint32(4, MHSD_HL, true);
    sv.setUint32(8, MHSD_HL + childData.length, true);
    sv.setUint32(12, 8, true);           // dataset_type = 8

    return concatBuffers([mhsd, childData]);
}

/**
 * Build an empty stub MHSD section (for types 5, 6, 10).
 *
 * Contains an empty child list header (mhlp for type 5, mhlt for 6 & 10)
 * with zero entries.
 *
 * @param {number} type - MHSD type
 * @returns {Uint8Array}
 */
function buildEmptyStub(type) {
    const MHSD_HL = 96;
    const CHILD_HL = 92;

    const childTag = (type === 5) ? 'mhlp' : 'mhlt';
    const child = new Uint8Array(CHILD_HL);
    const cv = new DataView(child.buffer);
    writeTag(child, 0, childTag);
    cv.setUint32(4, CHILD_HL, true);
    cv.setUint32(8, 0, true);            // 0 entries

    const mhsd = new Uint8Array(MHSD_HL);
    const sv = new DataView(mhsd.buffer);
    writeTag(mhsd, 0, 'mhsd');
    sv.setUint32(4, MHSD_HL, true);
    sv.setUint32(8, MHSD_HL + CHILD_HL, true);
    sv.setUint32(12, type, true);

    return concatBuffers([mhsd, child]);
}


// ── Main: rebuild index sections ────────────────────────────────────────────

/**
 * Rebuild the iTunesDB index sections.
 *
 * 1. Build album & artist maps from the WASM track data
 * 2. Strip all mhsd sections with type > 3 from the binary
 * 3. Patch each MHIT record with correct album_id (0x120) and artist_id (0x1E0)
 * 4. Generate fresh type 4 (album list) and type 8 (artist list) sections
 * 5. Append empty stubs for types 5, 6, 10
 * 6. Update mhbd header (total_length, num_children)
 *
 * @param {Uint8Array} dbData - The iTunesDB binary (will NOT be modified in-place)
 * @param {Array} tracks - Track info from ipod_get_all_tracks_json()
 * @param {Function} [log] - Logger function(msg, level)
 * @returns {Uint8Array} - New iTunesDB binary with rebuilt index sections
 */
export function rebuildIndexSections(dbData, tracks, log) {
    const v = new DataView(dbData.buffer, dbData.byteOffset, dbData.byteLength);
    const mhbdHL = v.getUint32(4, true);
    const numCh = v.getUint32(0x14, true);

    // ── Step 1: Build album and artist maps ─────────────────────────────
    const albumMap = new Map();   // albumName → { id, name }
    const artistMap = new Map();  // artistName → { id, name }
    let nextAlbumId = 1;
    let nextArtistId = 1;

    const trackAlbumIds = [];     // per-track album ID
    const trackArtistIds = [];    // per-track artist ID

    for (const track of tracks) {
        const albumName = track.album || 'Unknown Album';
        const artistName = track.artist || 'Unknown Artist';

        if (!albumMap.has(albumName)) {
            albumMap.set(albumName, { id: nextAlbumId++, name: albumName });
        }
        trackAlbumIds.push(albumMap.get(albumName).id);

        if (!artistMap.has(artistName)) {
            artistMap.set(artistName, { id: nextArtistId++, name: artistName });
        }
        trackArtistIds.push(artistMap.get(artistName).id);
    }

    log?.(`Index rebuild: ${tracks.length} tracks → ${albumMap.size} album(s), ${artistMap.size} artist(s)`, 'info');

    // ── Step 2: Strip mhsd types > 3 and compact ───────────────────────
    // Work on a copy so we don't modify the input
    const buf = new Uint8Array(dbData.length);
    buf.set(dbData);
    const bv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    let keepEnd = mhbdHL;
    let keptCount = 0;
    let type1Offset = -1;
    let strippedTypes = [];
    let p = mhbdHL;

    for (let i = 0; i < numCh && p + 16 <= buf.length; i++) {
        const tag = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
        if (tag !== 'mhsd') break;
        const sTL = bv.getUint32(p + 8, true);
        const sType = bv.getUint32(p + 0x0C, true);

        if (sType <= 3) {
            if (sType === 1) type1Offset = keepEnd;
            if (p !== keepEnd) buf.copyWithin(keepEnd, p, p + sTL);
            keepEnd += sTL;
            keptCount++;
        } else {
            strippedTypes.push(sType);
        }
        p += sTL;
    }

    // Trim to kept sections only
    let kept = new Uint8Array(keepEnd);
    kept.set(buf.subarray(0, keepEnd));

    if (strippedTypes.length > 0) {
        log?.(`Stripped ${strippedTypes.length} old mhsd section(s) (types ${strippedTypes.join(', ')})`, 'info');
    }

    // ── Step 3: Patch MHIT fields ──────────────────────────────────────
    //
    // For each MHIT record, set:
    //   - album_id  at 0x120 (4B) — cross-ref to MHIA in type 4
    //   - id_0x24   at 0x124 (8B) — database-level ID from mhbd[0x24]
    //   - artist_id at 0x1E0 (4B) — cross-ref to MHII in type 8

    // Read (or generate) the database-level id_0x24 from mhbd[0x24]
    const kv = new DataView(kept.buffer, kept.byteOffset, kept.byteLength);
    let dbId0x24 = kept.slice(0x24, 0x2C);  // 8 bytes
    if (dbId0x24.every(b => b === 0)) {
        // Generate a fresh value if unset
        dbId0x24 = crypto.getRandomValues(new Uint8Array(8));
        kept.set(dbId0x24, 0x24);
        log?.(`Generated mhbd id_0x24: 0x${Array.from(dbId0x24).map(b=>b.toString(16).padStart(2,'0')).join('')}`, 'info');
    }

    if (type1Offset >= 0) {
        const mhsdHL = kv.getUint32(type1Offset + 4, true);
        const mhltOffset = type1Offset + mhsdHL;

        if (mhltOffset + 12 <= kept.length) {
            const mhltTag = String.fromCharCode(
                kept[mhltOffset], kept[mhltOffset + 1],
                kept[mhltOffset + 2], kept[mhltOffset + 3]
            );
            if (mhltTag === 'mhlt') {
                const mhltHL = kv.getUint32(mhltOffset + 4, true);
                const trackCount = kv.getUint32(mhltOffset + 8, true);

                let tp = mhltOffset + mhltHL;
                let patchedAlbum = 0;
                let patchedArtist = 0;
                let patchedId24 = 0;

                for (let t = 0; t < trackCount && tp + 4 <= kept.length; t++) {
                    const tTag = String.fromCharCode(
                        kept[tp], kept[tp + 1], kept[tp + 2], kept[tp + 3]
                    );
                    if (tTag !== 'mhit') break;

                    const mhitHL = kv.getUint32(tp + 4, true);
                    const mhitTL = kv.getUint32(tp + 8, true);

                    // Patch album_id at MHIT offset 0x120 (4 bytes LE)
                    if (t < trackAlbumIds.length && mhitHL >= 0x124) {
                        kv.setUint32(tp + 0x120, trackAlbumIds[t], true);
                        patchedAlbum++;
                    }

                    // Patch id_0x24 at MHIT offset 0x124 (8 bytes) — must match mhbd[0x24]
                    if (mhitHL >= 0x12C) {
                        kept.set(dbId0x24, tp + 0x124);
                        patchedId24++;
                    }

                    // Patch artist_id at MHIT offset 0x1E0 (4 bytes LE)
                    if (t < trackArtistIds.length && mhitHL >= 0x1E4) {
                        kv.setUint32(tp + 0x1E0, trackArtistIds[t], true);
                        patchedArtist++;
                    }

                    // Diagnostic: dump key fields for first few tracks
                    if (t < 5 && mhitHL >= 0x1E4) {
                        const dbid = kv.getBigUint64(tp + 0x70, true);
                        const mediatype = kv.getUint32(tp + 0xD8, true);
                        const hasArtwork = kept[tp + 0xA4];
                        const albumId = kv.getUint32(tp + 0x120, true);
                        const artistId = kv.getUint32(tp + 0x1E0, true);
                        log?.(`  MHIT[${t}]: dbid=0x${dbid.toString(16)}, media=${mediatype}, art=${hasArtwork}, album_id=${albumId}, artist_id=${artistId}, hdr=${mhitHL}`, 'info');
                    }

                    tp += mhitTL;
                }

                log?.(`Patched MHIT: ${patchedAlbum} album_id, ${patchedId24} id_0x24, ${patchedArtist} artist_id (${trackCount} tracks, hdr=${trackCount > 0 ? kv.getUint32(mhltOffset + mhltHL + 4, true) : 0}B)`, 'info');
            }
        }
    }

    // ── Step 4: Generate new sections ───────────────────────────────────
    const albumSection = buildAlbumSection([...albumMap.values()]);
    const artistSection = buildArtistSection([...artistMap.values()]);
    const stub5 = buildEmptyStub(5);
    const stub6 = buildEmptyStub(6);
    const stub10 = buildEmptyStub(10);

    const newSections = concatBuffers([albumSection, artistSection, stub5, stub6, stub10]);
    const newChildCount = keptCount + 5;  // 3 kept + 5 new (4, 8, 5, 6, 10)

    // ── Step 5: Assemble final database ─────────────────────────────────
    const result = concatBuffers([kept, newSections]);
    const rv = new DataView(result.buffer, result.byteOffset, result.byteLength);
    rv.setUint32(0x08, result.length, true);   // mhbd total_length
    rv.setUint32(0x14, newChildCount, true);   // mhbd num_children

    log?.(`Rebuilt database: ${result.length} bytes, ${newChildCount} mhsd children`, 'info');

    return result;
}
