/**
 * Pure JavaScript ArtworkDB + .ithmb writer for iPod.
 *
 * Bypasses libgpod's artwork API (which needs GdkPixbuf, unavailable in WASM)
 * and writes the binary artwork database files directly.
 *
 * File format reference: libgpod db-artwork-writer.c / db-artwork-parser.c
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const MHFD_SIZE = 0x84;   // 132
const MHSD_SIZE = 0x60;   // 96
const MHLI_SIZE = 0x5C;   // 92
const MHII_SIZE = 0x98;   // 152
const MHOD_CONTAINER_SIZE = 0x18; // 24
const MHNI_SIZE = 0x4C;   // 76
const MHLA_SIZE = 0x5C;   // 92
const MHLF_SIZE = 0x5C;   // 92
const MHIF_SIZE = 0x7C;   // 124

const MIN_IMAGE_ID = 0x64; // 100 — minimum artwork ID per libgpod
const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

// ─── Known Format IDs ────────────────────────────────────────────────────────
// Maps format ID → { width, height, crop } for all known iPod models.
// Source: libgpod itdb_device.c + SysInfoExtended from real devices.
const FORMAT_SPECS = {
    // iPod Photo / Color (4th gen)
    1017: { width: 56,  height: 56,  crop: false },
    1016: { width: 140, height: 140, crop: false },
    // iPod Nano 1G/2G
    1031: { width: 42,  height: 42,  crop: false },
    1027: { width: 100, height: 100, crop: false },
    // iPod Video (5th gen)
    1028: { width: 100, height: 100, crop: false },
    1029: { width: 200, height: 200, crop: false },
    // iPod Nano 3G / iPod Classic (all gens)
    1061: { width: 56,  height: 56,  crop: false },
    1055: { width: 128, height: 128, crop: false },
    1060: { width: 320, height: 320, crop: false },
    // iPod Nano 4G
    1071: { width: 240, height: 240, crop: false },
    1074: { width: 50,  height: 50,  crop: false },
    1078: { width: 80,  height: 80,  crop: true  },
    // iPod Nano 5G
    1056: { width: 128, height: 128, crop: false },
    1073: { width: 240, height: 240, crop: false },
    // iPod Nano 6G
    1085: { width: 88,  height: 88,  crop: true  },
    1089: { width: 58,  height: 58,  crop: false },
    // iPod Nano 7G
    1010: { width: 240, height: 240, crop: false },
    1013: { width: 50,  height: 50,  crop: false },
};

/**
 * Look up format specs from the built-in table.
 * Returns array of { formatId, width, height, crop } for recognized IDs.
 */
export function lookupFormatSpecs(formatIds) {
    const result = [];
    for (const id of formatIds) {
        const spec = FORMAT_SPECS[id];
        if (spec) result.push({ formatId: id, ...spec });
    }
    return result;
}

// ─── Plist Parsing ───────────────────────────────────────────────────────────

/**
 * Parse AlbumArt format specifications from SysInfoExtended.plist XML.
 * Returns an array of { formatId, width, height, crop }.
 */
export function parseAlbumArtFormats(plistXml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(plistXml, 'text/xml');

    // Find the AlbumArt or AlbumArt2 key
    const keys = doc.querySelectorAll('dict > key');
    let artArray = null;
    for (const key of keys) {
        const name = key.textContent.trim();
        if (name === 'AlbumArt2' || name === 'AlbumArt') {
            const next = key.nextElementSibling;
            if (next?.tagName === 'array') {
                artArray = next;
                if (name === 'AlbumArt2') break; // prefer AlbumArt2
            }
        }
    }
    if (!artArray) return [];

    const formats = [];
    for (const dict of artArray.querySelectorAll(':scope > dict')) {
        const entry = parsePlistDict(dict);
        const formatId = entry.FormatId;
        const width = entry.RenderWidth;
        const height = entry.RenderHeight;
        if (!Number.isFinite(formatId) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
        // Skip secondary formats (AssociatedFormat > 0 means it duplicates a primary)
        if (Number.isFinite(entry.AssociatedFormat) && entry.AssociatedFormat > 0) continue;
        formats.push({ formatId, width, height, crop: !!entry.Crop });
    }
    return formats;
}

function parsePlistDict(dictEl) {
    const result = {};
    const children = dictEl.children;
    for (let i = 0; i < children.length - 1; i++) {
        if (children[i].tagName !== 'key') continue;
        const key = children[i].textContent.trim();
        const val = children[i + 1];
        if (val.tagName === 'integer') result[key] = parseInt(val.textContent, 10);
        else if (val.tagName === 'real') result[key] = parseFloat(val.textContent);
        else if (val.tagName === 'string') result[key] = val.textContent;
        else if (val.tagName === 'true') result[key] = true;
        else if (val.tagName === 'false') result[key] = false;
    }
    return result;
}

// ─── Image Processing ────────────────────────────────────────────────────────

/**
 * Resize image data (JPEG/PNG bytes) to target dimensions, return RGBA pixels.
 */
async function resizeToRGBA(imageData, targetW, targetH, crop = false) {
    const blob = new Blob([imageData]);
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');

    // Black background for letterbox
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, targetW, targetH);

    if (crop) {
        // Crop-to-fill: scale to cover, crop excess
        const scale = Math.max(targetW / bitmap.width, targetH / bitmap.height);
        const sw = targetW / scale;
        const sh = targetH / scale;
        const sx = (bitmap.width - sw) / 2;
        const sy = (bitmap.height - sh) / 2;
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
    } else {
        // Fit: scale to fit, letterbox
        const scale = Math.min(targetW / bitmap.width, targetH / bitmap.height);
        const dw = Math.round(bitmap.width * scale);
        const dh = Math.round(bitmap.height * scale);
        const dx = Math.round((targetW - dw) / 2);
        const dy = Math.round((targetH - dh) / 2);
        ctx.drawImage(bitmap, dx, dy, dw, dh);
    }

    bitmap.close();
    return ctx.getImageData(0, 0, targetW, targetH).data;
}

/**
 * Convert RGBA pixel data to RGB565 little-endian (2 bytes per pixel).
 */
function rgbaToRgb565(rgba, width, height) {
    const out = new Uint8Array(width * height * 2);
    const view = new DataView(out.buffer);
    const total = width * height;
    for (let i = 0; i < total; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        view.setUint16(i * 2, ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), true);
    }
    return out;
}

// ─── Size Calculation ────────────────────────────────────────────────────────

function mhodFilenameByteLen(formatId) {
    const filename = `:F${formatId}_1.ithmb`;
    const utf16Len = filename.length * 2;
    const padLen = (4 - (utf16Len % 4)) % 4;
    return 0x24 + utf16Len + padLen;
}

function calcPerFormatPerTrack(formatId) {
    return MHOD_CONTAINER_SIZE + MHNI_SIZE + mhodFilenameByteLen(formatId);
}

function calcMhiiTotal(formats) {
    let children = 0;
    for (const f of formats) children += calcPerFormatPerTrack(f.formatId);
    return MHII_SIZE + children;
}

function calcDbSize(numEntries, formats) {
    const mhiiTotal = calcMhiiTotal(formats);
    const sec1 = MHSD_SIZE + MHLI_SIZE + numEntries * mhiiTotal;
    const sec2 = MHSD_SIZE + MHLA_SIZE;
    const sec3 = MHSD_SIZE + MHLF_SIZE + formats.length * MHIF_SIZE;
    return MHFD_SIZE + sec1 + sec2 + sec3;
}

// ─── Binary Writers ──────────────────────────────────────────────────────────

function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function writeMhfd(view, off, totalLen, nextId) {
    writeAscii(view, off, 'mhfd');
    view.setUint32(off + 0x04, MHFD_SIZE, true);
    view.setUint32(off + 0x08, totalLen, true);
    view.setUint32(off + 0x10, 2, true);          // unknown2 = 2
    view.setUint32(off + 0x14, 3, true);           // num_children = 3 sections
    view.setUint32(off + 0x1C, nextId, true);      // next_id (highest artwork ID)
    view.setUint8(off + 0x30, 2);                  // unknown_flag1 = 2
}

function writeMhsd(view, off, index, totalLen) {
    writeAscii(view, off, 'mhsd');
    view.setUint32(off + 0x04, MHSD_SIZE, true);
    view.setUint32(off + 0x08, totalLen, true);
    view.setUint16(off + 0x0C, index, true);
}

function writeMhli(view, off, numChildren) {
    writeAscii(view, off, 'mhli');
    view.setUint32(off + 0x04, MHLI_SIZE, true);
    view.setUint32(off + 0x08, numChildren, true);
}

function writeMhii(view, off, imageId, dbid, numFormats, totalLen, origSize) {
    writeAscii(view, off, 'mhii');
    view.setUint32(off + 0x04, MHII_SIZE, true);
    view.setUint32(off + 0x08, totalLen, true);
    view.setUint32(off + 0x0C, numFormats, true);  // num_children (one mhod per format)
    view.setUint32(off + 0x10, imageId, true);
    // song_id (dbid) as uint64 LE — dbid may be BigInt (exact) or Number (imprecise)
    view.setBigUint64(off + 0x14, typeof dbid === 'bigint' ? dbid : BigInt(dbid), true);
    // orig_date / digitized_date: 0 for music artwork (matches iOpenPod / iTunes behavior).
    // Non-zero timestamps can confuse firmware on some iPod models.
    // offsets 0x28 and 0x2C are already 0 from the zeroed ArrayBuffer.
    view.setUint32(off + 0x30, origSize, true);     // orig_img_size
}

function writeMhodContainer(view, off, totalLen) {
    writeAscii(view, off, 'mhod');
    view.setUint32(off + 0x04, MHOD_CONTAINER_SIZE, true);
    view.setUint32(off + 0x08, totalLen, true);
    view.setUint16(off + 0x0C, 2, true);           // type = 2 (thumbnail container)
}

function writeMhni(view, off, formatId, itmbOffset, imgSize, width, height, totalLen) {
    writeAscii(view, off, 'mhni');
    view.setUint32(off + 0x04, MHNI_SIZE, true);
    view.setUint32(off + 0x08, totalLen, true);
    view.setUint32(off + 0x0C, 1, true);            // num_children = 1 (the filename mhod)
    view.setUint32(off + 0x10, formatId, true);
    view.setUint32(off + 0x14, itmbOffset, true);
    view.setUint32(off + 0x18, imgSize, true);
    view.setUint16(off + 0x20, height, true);       // image_height
    view.setUint16(off + 0x22, width, true);        // image_width
    view.setUint32(off + 0x28, imgSize, true);      // imgSize2 — duplicate of imgSize at 0x18
}

/**
 * Write mhod type=3 (filename) directly into the buffer.
 * Returns the number of bytes written.
 */
function writeMhodFilename(view, off, formatId) {
    const filename = `:F${formatId}_1.ithmb`;
    const utf16Len = filename.length * 2;
    const padLen = (4 - (utf16Len % 4)) % 4;
    // header_len = 0x18 (24): iPod firmware uses this to find the string body.
    // The actual chunk occupies 0x24 bytes before the string, but the firmware
    // header is only 0x18.  Using 0x24 here causes the iPod to misparse the
    // ithmb filename (reads UTF-16 bytes as metadata).
    const headerLen = 0x18;
    const totalLen = 0x24 + utf16Len + padLen;       // actual chunk size unchanged

    writeAscii(view, off, 'mhod');
    view.setUint32(off + 0x04, headerLen, true);
    view.setUint32(off + 0x08, totalLen, true);
    view.setUint16(off + 0x0C, 3, true);            // type = 3 (filename)
    view.setUint8(off + 0x0F, padLen);               // padding_len
    view.setUint32(off + 0x18, utf16Len, true);      // string_len
    view.setUint8(off + 0x1C, 2);                    // encoding = 2 (UTF-16LE)

    // Write UTF-16LE string at byte 0x24 (after the full header area)
    const strOff = off + 0x24;
    for (let i = 0; i < filename.length; i++) {
        view.setUint16(strOff + i * 2, filename.charCodeAt(i), true);
    }

    return totalLen;
}

function writeMhla(view, off) {
    writeAscii(view, off, 'mhla');
    view.setUint32(off + 0x04, MHLA_SIZE, true);
    view.setUint32(off + 0x08, 0, true);             // num_children = 0 (no albums)
}

function writeMhlf(view, off, numFormats) {
    writeAscii(view, off, 'mhlf');
    view.setUint32(off + 0x04, MHLF_SIZE, true);
    view.setUint32(off + 0x08, numFormats, true);
}

function writeMhif(view, off, formatId, imageSize) {
    writeAscii(view, off, 'mhif');
    view.setUint32(off + 0x04, MHIF_SIZE, true);
    view.setUint32(off + 0x08, MHIF_SIZE, true);    // total_len = header_len (no children)
    view.setUint32(off + 0x10, formatId, true);
    view.setUint32(off + 0x14, imageSize, true);
}

// ─── Main Entry Points ──────────────────────────────────────────────────────

/**
 * Generate ArtworkDB binary + .ithmb files for the given artwork entries.
 *
 * Entries can have two forms:
 *   - { dbid, imageData: Uint8Array }       — JPEG/PNG bytes, will be resized & converted
 *   - { dbid, preRendered: Map<formatId, Uint8Array> } — existing RGB565 data from a previous ArtworkDB
 *
 * @param {Array<{ dbid: number|bigint, imageData?: Uint8Array, preRendered?: Map<number, Uint8Array>, origSize?: number }>} entries
 * @param {Array<{ formatId: number, width: number, height: number, crop?: boolean }>} formats
 * @param {Function} [onProgress] - Optional progress callback({ current, total, detail }).
 * @returns {Promise<{ artworkDb: Uint8Array, ithmbs: Map<string, Uint8Array> }>}
 */
export async function generateArtworkFiles(entries, formats, onProgress) {
    if (!entries.length || !formats.length) {
        return { artworkDb: new Uint8Array(0), ithmbs: new Map() };
    }

    // 1. Build .ithmb data: for each format, resize + convert all images
    //    Track offsets for the ArtworkDB mhni entries.
    //    thumbnailInfo[entryIdx][formatIdx] = { offset, size }
    const thumbnailInfo = [];
    const itmbBuffers = new Map(); // formatId → [Uint8Array chunks]
    const itmbOffsets = new Map(); // formatId → current write offset

    for (const f of formats) {
        itmbBuffers.set(f.formatId, []);
        itmbOffsets.set(f.formatId, 0);
    }

    for (let ei = 0; ei < entries.length; ei++) {
        const entry = entries[ei];
        const info = [];
        thumbnailInfo.push(info);

        try { onProgress?.({ current: ei + 1, total: entries.length, detail: `Processing artwork ${ei + 1}/${entries.length}` }); } catch (_) {}

        for (const f of formats) {
            let rgb565;
            const expectedSize = f.width * f.height * 2;

            if (entry.preRendered?.has(f.formatId)) {
                // Use existing RGB565 data (preserved from previous ArtworkDB)
                const existing = entry.preRendered.get(f.formatId);
                rgb565 = (existing.length === expectedSize) ? existing : new Uint8Array(expectedSize);
            } else if (entry.imageData) {
                // Convert JPEG/PNG to RGB565
                try {
                    const rgba = await resizeToRGBA(entry.imageData, f.width, f.height, f.crop);
                    rgb565 = rgbaToRgb565(rgba, f.width, f.height);
                } catch (e) {
                    rgb565 = new Uint8Array(expectedSize);
                }
            } else {
                // No image data available — black placeholder
                rgb565 = new Uint8Array(expectedSize);
            }

            const offset = itmbOffsets.get(f.formatId);
            info.push({ offset, size: rgb565.length });
            itmbBuffers.get(f.formatId).push(rgb565);
            itmbOffsets.set(f.formatId, offset + rgb565.length);
        }
    }

    // Concatenate ithmb chunks per format
    const ithmbs = new Map();
    for (const f of formats) {
        const chunks = itmbBuffers.get(f.formatId);
        const totalSize = itmbOffsets.get(f.formatId);
        const merged = new Uint8Array(totalSize);
        let off = 0;
        for (const chunk of chunks) {
            merged.set(chunk, off);
            off += chunk.length;
        }
        ithmbs.set(`F${f.formatId}_1.ithmb`, merged);
    }

    // 2. Build ArtworkDB binary
    const dbSize = calcDbSize(entries.length, formats);
    const buf = new ArrayBuffer(dbSize);
    const view = new DataView(buf);
    let pos = 0;

    const nextId = MIN_IMAGE_ID + entries.length;
    const mhiiTotal = calcMhiiTotal(formats);

    // Section sizes
    const sec1Content = MHLI_SIZE + entries.length * mhiiTotal;
    const sec1Total = MHSD_SIZE + sec1Content;
    const sec2Total = MHSD_SIZE + MHLA_SIZE;
    const sec3Total = MHSD_SIZE + MHLF_SIZE + formats.length * MHIF_SIZE;

    // mhfd
    writeMhfd(view, pos, dbSize, nextId);
    pos += MHFD_SIZE;

    // Section 1: Image list
    writeMhsd(view, pos, 1, sec1Total);
    pos += MHSD_SIZE;

    writeMhli(view, pos, entries.length);
    pos += MHLI_SIZE;

    for (let ei = 0; ei < entries.length; ei++) {
        const entry = entries[ei];
        const imageId = MIN_IMAGE_ID + ei;

        const origSize = entry.imageData ? entry.imageData.length : (entry.origSize || 0);
        writeMhii(view, pos, imageId, entry.dbid, formats.length, mhiiTotal, origSize);
        pos += MHII_SIZE;

        for (let fi = 0; fi < formats.length; fi++) {
            const f = formats[fi];
            const ti = thumbnailInfo[ei][fi];
            const mhodFnLen = mhodFilenameByteLen(f.formatId);
            const mhniTotal = MHNI_SIZE + mhodFnLen;
            const mhodContTotal = MHOD_CONTAINER_SIZE + mhniTotal;

            writeMhodContainer(view, pos, mhodContTotal);
            pos += MHOD_CONTAINER_SIZE;

            writeMhni(view, pos, f.formatId, ti.offset, ti.size, f.width, f.height, mhniTotal);
            pos += MHNI_SIZE;

            writeMhodFilename(view, pos, f.formatId);
            pos += mhodFnLen;
        }
    }

    // Section 2: Album list (empty)
    writeMhsd(view, pos, 2, sec2Total);
    pos += MHSD_SIZE;
    writeMhla(view, pos);
    pos += MHLA_SIZE;

    // Section 3: File/format list
    writeMhsd(view, pos, 3, sec3Total);
    pos += MHSD_SIZE;
    writeMhlf(view, pos, formats.length);
    pos += MHLF_SIZE;

    for (const f of formats) {
        const imgSize = f.width * f.height * 2; // RGB565: 2 bytes/pixel
        writeMhif(view, pos, f.formatId, imgSize);
        pos += MHIF_SIZE;
    }

    return { artworkDb: new Uint8Array(buf), ithmbs };
}

// ─── Debug Preview ──────────────────────────────────────────────────────────

/**
 * Convert RGB565 ithmb data back to a visible PNG and open in a new tab.
 * Use this to verify artwork images are generated correctly.
 *
 * @param {Uint8Array} rgb565Data — raw RGB565 bytes (full ithmb or single image)
 * @param {number} width — image width in pixels
 * @param {number} height — image height in pixels
 * @param {number} [imageIndex=0] — which image to preview (0-based)
 * @returns {Promise<string>} — blob URL of the generated PNG
 */
export async function debugPreviewIthmb(rgb565Data, width, height, imageIndex = 0) {
    const bytesPerImage = width * height * 2;
    const offset = imageIndex * bytesPerImage;
    if (offset + bytesPerImage > rgb565Data.length) {
        throw new Error(`Image index ${imageIndex} out of range (need ${offset + bytesPerImage} bytes, have ${rgb565Data.length})`);
    }

    const view = new DataView(rgb565Data.buffer, rgb565Data.byteOffset + offset, bytesPerImage);
    const rgba = new Uint8Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
        const pixel = view.getUint16(i * 2, true);
        const r = ((pixel >> 11) & 0x1F) << 3; // 5-bit → 8-bit
        const g = ((pixel >> 5) & 0x3F) << 2;  // 6-bit → 8-bit
        const b = (pixel & 0x1F) << 3;         // 5-bit → 8-bit
        rgba[i * 4]     = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = 255;
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer), width, height);
    ctx.putImageData(imgData, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const url = URL.createObjectURL(blob);
    console.log(`[ArtworkDebug] Preview: ${width}×${height}, image #${imageIndex}, ${bytesPerImage} bytes → ${url}`);

    // Show as overlay in current page
    try {
        const overlay = document.createElement('div');
        overlay.id = 'artwork-debug-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer';
        overlay.onclick = () => { overlay.remove(); URL.revokeObjectURL(url); };

        const label = document.createElement('div');
        label.textContent = `Artwork Preview — ${width}×${height} RGB565 — click to close`;
        label.style.cssText = 'color:#fff;font:16px sans-serif;margin-bottom:16px';
        overlay.appendChild(label);

        const img = document.createElement('img');
        img.src = url;
        img.style.cssText = `width:${Math.max(width * 2, 200)}px;height:${Math.max(height * 2, 200)}px;image-rendering:pixelated;border:2px solid #666;border-radius:4px`;
        overlay.appendChild(img);

        // Remove any existing overlay first
        document.getElementById('artwork-debug-overlay')?.remove();
        document.body.appendChild(overlay);
    } catch (_) {
        // fallback: URL is in console
    }

    return url;
}

// ─── Existing ArtworkDB Parser ───────────────────────────────────────────────

/**
 * Parse an existing ArtworkDB binary to extract artwork entries.
 *
 * Used to preserve existing artwork when syncing new tracks — we read the
 * old ArtworkDB, extract per-entry thumbnail offsets/sizes from .ithmb files,
 * and merge them with new entries before regenerating.
 *
 * @param {Uint8Array} dbData — raw ArtworkDB bytes from iPod
 * @returns {Array<{ dbid: bigint, imageId: number, origSize: number, thumbnails: Array<{ formatId: number, itmbOffset: number, imgSize: number }> }>}
 */
export function parseExistingArtworkDb(dbData) {
    if (!dbData || dbData.length < MHFD_SIZE) return [];

    const view = new DataView(dbData.buffer, dbData.byteOffset, dbData.byteLength);
    const tag = String.fromCharCode(dbData[0], dbData[1], dbData[2], dbData[3]);
    if (tag !== 'mhfd') return [];

    const mhfdHeaderLen = view.getUint32(4, true);
    const numSections = view.getUint32(0x14, true);

    let pos = mhfdHeaderLen;
    for (let s = 0; s < numSections && pos + 16 <= dbData.length; s++) {
        const stag = String.fromCharCode(dbData[pos], dbData[pos + 1], dbData[pos + 2], dbData[pos + 3]);
        if (stag !== 'mhsd') break;

        const mhsdHeaderLen = view.getUint32(pos + 4, true);
        const mhsdTotalLen = view.getUint32(pos + 8, true);
        const mhsdType = view.getUint16(pos + 0x0C, true);

        if (mhsdType === 1) {
            // Image list section
            const mhliPos = pos + mhsdHeaderLen;
            if (mhliPos + 12 > dbData.length) break;
            const ltag = String.fromCharCode(dbData[mhliPos], dbData[mhliPos + 1], dbData[mhliPos + 2], dbData[mhliPos + 3]);
            if (ltag !== 'mhli') break;

            const mhliHeaderLen = view.getUint32(mhliPos + 4, true);
            const numImages = view.getUint32(mhliPos + 8, true);

            const entries = [];
            let imgPos = mhliPos + mhliHeaderLen;

            for (let i = 0; i < numImages && imgPos + 0x34 <= dbData.length; i++) {
                const itag = String.fromCharCode(dbData[imgPos], dbData[imgPos + 1], dbData[imgPos + 2], dbData[imgPos + 3]);
                if (itag !== 'mhii') break;

                const mhiiHeaderLen = view.getUint32(imgPos + 4, true);
                const mhiiTotalLen = view.getUint32(imgPos + 8, true);
                const numChildren = view.getUint32(imgPos + 0x0C, true);
                const imageId = view.getUint32(imgPos + 0x10, true);
                const dbid = view.getBigUint64(imgPos + 0x14, true);
                const origSize = view.getUint32(imgPos + 0x30, true);

                // Walk children to find mhni entries (thumbnail/format info)
                const thumbnails = [];
                let childPos = imgPos + mhiiHeaderLen;
                const childEnd = imgPos + mhiiTotalLen;

                for (let c = 0; c < numChildren && childPos + 12 <= childEnd; c++) {
                    const ctag = String.fromCharCode(dbData[childPos], dbData[childPos + 1], dbData[childPos + 2], dbData[childPos + 3]);
                    if (ctag !== 'mhod') {
                        const cTotalLen = view.getUint32(childPos + 8, true);
                        childPos += cTotalLen || 1;
                        continue;
                    }

                    const mhodTotalLen = view.getUint32(childPos + 8, true);
                    const mhodType = view.getUint16(childPos + 0x0C, true);

                    if (mhodType === 2) {
                        // Container wrapping mhni
                        const mhniPos = childPos + MHOD_CONTAINER_SIZE;
                        if (mhniPos + MHNI_SIZE <= dbData.length) {
                            const ntag = String.fromCharCode(dbData[mhniPos], dbData[mhniPos + 1], dbData[mhniPos + 2], dbData[mhniPos + 3]);
                            if (ntag === 'mhni') {
                                const formatId = view.getUint32(mhniPos + 0x10, true);
                                const itmbOffset = view.getUint32(mhniPos + 0x14, true);
                                const imgSize = view.getUint32(mhniPos + 0x18, true);
                                thumbnails.push({ formatId, itmbOffset, imgSize });
                            }
                        }
                    }

                    childPos += mhodTotalLen;
                }

                entries.push({ dbid, imageId, thumbnails, origSize });
                imgPos += mhiiTotalLen;
            }

            return entries;
        }

        pos += mhsdTotalLen;
    }

    return [];
}

// ─── iTunesDB Binary Patching ───────────────────────────────────────────────

/**
 * Patch has_artwork / artwork_count / artwork_size fields in an iTunesDB binary.
 *
 * The iPod firmware checks has_artwork (0xA4) in mhit before looking up
 * artwork in the ArtworkDB.  Since we write ArtworkDB ourselves (bypassing
 * libgpod's artwork API), we must set these fields manually.
 *
 * @param {Uint8Array} dbData — raw iTunesDB bytes (read from MEMFS)
 * @param {Set<number>} artworkDbids — set of dbids that have artwork
 * @param {number} numFormats — number of artwork formats generated
 * @param {number} ithmbSizePerTrack — total RGB565 bytes per track (sum over all formats)
 * @returns {{ data: Uint8Array, patched: number }}
 */
export function patchITunesDbArtwork(dbData, artworkDbids, numFormats, ithmbSizePerTrack) {
    if (!dbData || dbData.length < 0x20 || artworkDbids.size === 0) return { data: dbData, patched: 0 };

    const view = new DataView(dbData.buffer, dbData.byteOffset, dbData.byteLength);

    // Verify mhbd header
    if (String.fromCharCode(dbData[0], dbData[1], dbData[2], dbData[3]) !== 'mhbd') {
        console.warn('[ArtworkPatch] Not an iTunesDB (missing mhbd)');
        return { data: dbData, patched: 0 };
    }

    const mhbdHeaderLen = view.getUint32(4, true);
    const numMhsd = view.getUint32(0x10, true); // num_children at offset 0x10

    // Walk mhsd sections, find type=1 (track list)
    let pos = mhbdHeaderLen;
    for (let i = 0; i < numMhsd && pos + 16 <= dbData.length; i++) {
        if (String.fromCharCode(dbData[pos], dbData[pos + 1], dbData[pos + 2], dbData[pos + 3]) !== 'mhsd') break;
        const mhsdHeaderLen = view.getUint32(pos + 4, true);
        const mhsdTotalLen = view.getUint32(pos + 8, true);
        const mhsdType = view.getUint32(pos + 0x0C, true);

        if (mhsdType === 1) {
            // Track dataset — find mhlt
            const mhltPos = pos + mhsdHeaderLen;
            if (mhltPos + 12 > dbData.length) break;
            if (String.fromCharCode(dbData[mhltPos], dbData[mhltPos + 1], dbData[mhltPos + 2], dbData[mhltPos + 3]) !== 'mhlt') break;

            const mhltHeaderLen = view.getUint32(mhltPos + 4, true);
            const numTracks = view.getUint32(mhltPos + 8, true);
            console.log(`[ArtworkPatch] Found mhlt: ${numTracks} tracks, looking for ${artworkDbids.size} dbids`);

            // ── Pass 1: Clear has_artwork / artwork_count / artwork_size for ALL tracks ──
            // Previous sync attempts may have set has_artwork=1 on tracks that no
            // longer have entries in the current ArtworkDB.  The iPod firmware may
            // reject the entire ArtworkDB when it finds tracks with has_artwork=1
            // but no matching song_id in the ArtworkDB.
            let cleared = 0;
            let trackPos = mhltPos + mhltHeaderLen;
            for (let t = 0; t < numTracks && trackPos + 0x10 <= dbData.length; t++) {
                if (String.fromCharCode(dbData[trackPos], dbData[trackPos + 1], dbData[trackPos + 2], dbData[trackPos + 3]) !== 'mhit') break;
                const mhitHeaderLen = view.getUint32(trackPos + 4, true);
                const mhitTotalLen = view.getUint32(trackPos + 8, true);

                if (mhitHeaderLen >= 0xA5) {
                    const oldHasArt = view.getUint8(trackPos + 0xA4);
                    if (oldHasArt !== 0) {
                        view.setUint8(trackPos + 0xA4, 0x00);
                        if (mhitHeaderLen >= 0x7E) view.setUint16(trackPos + 0x7C, 0, true);
                        if (mhitHeaderLen >= 0x84) view.setUint32(trackPos + 0x80, 0, true);
                        cleared++;
                    }
                }
                trackPos += mhitTotalLen;
            }
            if (cleared > 0) {
                console.log(`[ArtworkPatch] Cleared stale has_artwork on ${cleared} track(s) from previous sync(s)`);
            }

            // ── Pass 2: Set has_artwork for tracks in our current artwork set ──
            let patched = 0;
            trackPos = mhltPos + mhltHeaderLen;
            for (let t = 0; t < numTracks && trackPos + 0x10 <= dbData.length; t++) {
                if (String.fromCharCode(dbData[trackPos], dbData[trackPos + 1], dbData[trackPos + 2], dbData[trackPos + 3]) !== 'mhit') break;
                const mhitHeaderLen = view.getUint32(trackPos + 4, true);
                const mhitTotalLen = view.getUint32(trackPos + 8, true);

                // Read dbid at offset 0x70 (uint64 LE — read as two uint32s)
                if (mhitHeaderLen >= 0x78) {
                    const dbidLow = view.getUint32(trackPos + 0x70, true);
                    const dbidHigh = view.getUint32(trackPos + 0x74, true);
                    const dbid = dbidLow + dbidHigh * 0x100000000;

                    if (artworkDbids.has(dbid)) {
                        // artwork_count at 0x7C (uint16 LE)
                        if (mhitHeaderLen >= 0x7E) view.setUint16(trackPos + 0x7C, numFormats, true);
                        // artwork_size at 0x80 (uint32 LE) — total RGB565 thumbnail bytes
                        if (mhitHeaderLen >= 0x84) view.setUint32(trackPos + 0x80, ithmbSizePerTrack, true);
                        // has_artwork at 0xA4 (uint8): 0x01 = has artwork
                        if (mhitHeaderLen >= 0xA5) view.setUint8(trackPos + 0xA4, 0x01);
                        patched++;

                        // Verify: dump exact dbid bytes for comparison with ArtworkDB song_id
                        const dbidBig = BigInt(dbidLow) + BigInt(dbidHigh) * 0x100000000n;
                        const dbidBytes = Array.from(dbData.slice(trackPos + 0x70, trackPos + 0x78)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                        console.log(`[ArtworkPatch] ✓ MATCH track#${t}: dbid=0x${dbidBig.toString(16)} bytes=[${dbidBytes}]`);
                    }
                }

                trackPos += mhitTotalLen;
            }

            console.log(`[ArtworkPatch] Patched ${patched}/${numTracks} tracks`);
            if (patched === 0 && artworkDbids.size > 0) {
                console.warn('[ArtworkPatch] ⚠ NO MATCHES! dbid mismatch');
            }

            return { data: dbData, patched };
        }

        pos += mhsdTotalLen;
    }
    console.warn('[ArtworkPatch] No track list (mhsd type=1) found');
    return { data: dbData, patched: 0 };
}

// ─── dbid Precision Fix ─────────────────────────────────────────────────────

/**
 * Extract exact 64-bit BigInt dbids from an iTunesDB binary for a set of
 * imprecise JavaScript Number dbids.
 *
 * JavaScript's Number type (64-bit double, max 2^53 integer precision) rounds
 * 64-bit iPod dbids. JSON.parse(ipod_get_track_json) thus produces an imprecise
 * Number. When we write that into the ArtworkDB's song_id field (uint64 LE),
 * the iPod can't match it to the track's actual dbid.
 *
 * This function walks the iTunesDB binary, reads each track's dbid as a proper
 * BigInt, and returns a Map from the imprecise Number to the exact BigInt.
 *
 * @param {Uint8Array} dbData — raw iTunesDB bytes
 * @param {number[]} targetNumberDbids — imprecise Number dbids to look up
 * @returns {Map<number, bigint>} — Number → exact BigInt
 */
export function extractExactDbids(dbData, targetNumberDbids) {
    const result = new Map();
    if (!dbData || dbData.length < 0x20 || targetNumberDbids.length === 0) return result;

    const targetSet = new Set(targetNumberDbids);
    const view = new DataView(dbData.buffer, dbData.byteOffset, dbData.byteLength);

    // Verify mhbd header
    if (String.fromCharCode(dbData[0], dbData[1], dbData[2], dbData[3]) !== 'mhbd') return result;

    const mhbdHeaderLen = view.getUint32(4, true);
    const numMhsd = view.getUint32(0x10, true);

    // Walk mhsd sections, find type=1 (track list)
    let pos = mhbdHeaderLen;
    for (let i = 0; i < numMhsd && pos + 16 <= dbData.length; i++) {
        if (String.fromCharCode(dbData[pos], dbData[pos + 1], dbData[pos + 2], dbData[pos + 3]) !== 'mhsd') break;
        const mhsdHeaderLen = view.getUint32(pos + 4, true);
        const mhsdTotalLen = view.getUint32(pos + 8, true);
        const mhsdType = view.getUint32(pos + 0x0C, true);

        if (mhsdType === 1) {
            // Track dataset — find mhlt
            const mhltPos = pos + mhsdHeaderLen;
            if (mhltPos + 12 > dbData.length) break;
            if (String.fromCharCode(dbData[mhltPos], dbData[mhltPos + 1], dbData[mhltPos + 2], dbData[mhltPos + 3]) !== 'mhlt') break;

            const mhltHeaderLen = view.getUint32(mhltPos + 4, true);
            const numTracks = view.getUint32(mhltPos + 8, true);

            let trackPos = mhltPos + mhltHeaderLen;
            for (let t = 0; t < numTracks && trackPos + 0x10 <= dbData.length; t++) {
                if (String.fromCharCode(dbData[trackPos], dbData[trackPos + 1], dbData[trackPos + 2], dbData[trackPos + 3]) !== 'mhit') break;
                const mhitHeaderLen = view.getUint32(trackPos + 4, true);
                const mhitTotalLen = view.getUint32(trackPos + 8, true);

                if (mhitHeaderLen >= 0x78) {
                    const dbidLow = view.getUint32(trackPos + 0x70, true);
                    const dbidHigh = view.getUint32(trackPos + 0x74, true);
                    // Reconstruct the same imprecise Number that JSON.parse would yield
                    const dbidNumber = dbidLow + dbidHigh * 0x100000000;

                    if (targetSet.has(dbidNumber)) {
                        // Build the exact 64-bit BigInt from the two 32-bit halves
                        const dbidExact = BigInt(dbidLow) + BigInt(dbidHigh) * 0x100000000n;
                        result.set(dbidNumber, dbidExact);
                    }
                }

                trackPos += mhitTotalLen;
            }
            break; // found type=1, done
        }

        pos += mhsdTotalLen;
    }

    return result;
}
