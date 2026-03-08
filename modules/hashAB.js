/**
 * hashAB.js — JavaScript hashAB computation using the pre-built calcHashAB.wasm
 *
 * Uses the verified WASM module from dstaley/hashab instead of the C code
 * compiled through emscripten, ensuring correct hash computation for iPod
 * Nano 6th/7th Gen devices.
 *
 * Provides two functions:
 *   recomputeITunesCDBHash(data, uuid)  — patches the hashAB in an iTunesCDB buffer
 *   computeLocationsCBK(locationsData, uuid) — builds a complete Locations.itdb.cbk
 */

let wasmInstance = null;

/**
 * Initialize the WASM module. Must be called once before using hash functions.
 */
export async function initHashAB() {
    if (wasmInstance) return;

    const resp = await fetch(new URL('./calcHashAB.wasm', import.meta.url));
    const wasmBuffer = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
    wasmInstance = instance;
}

/**
 * Compute a 57-byte HashAB signature from a 20-byte SHA1 and 8-byte UUID.
 * @param {Uint8Array} sha1  — 20 bytes
 * @param {Uint8Array} uuid  — 8 bytes (FirewireGuid)
 * @returns {Uint8Array} — 57-byte signature (starts with 03 00)
 */
function calcHashAB(sha1, uuid) {
    if (!wasmInstance) throw new Error('hashAB WASM not initialized — call initHashAB() first');

    const { getInputSha1, getInputUuid, getOutput, calculateHash, memory } = wasmInstance.exports;
    const mem = new Uint8Array(memory.buffer);

    const sha1Ptr = getInputSha1();
    const uuidPtr = getInputUuid();
    const outputPtr = getOutput();

    mem.set(sha1, sha1Ptr);
    mem.set(uuid, uuidPtr);
    calculateHash();

    return new Uint8Array(mem.slice(outputPtr, outputPtr + 57));
}

/**
 * Compute SHA-1 of a Uint8Array using the Web Crypto API.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>} — 20-byte SHA1
 */
async function sha1(data) {
    const hash = await crypto.subtle.digest('SHA-1', data);
    return new Uint8Array(hash);
}

// ─── iTunesCDB (mhbd) header offsets ───
const MHBD_DB_ID_OFFSET   = 0x18;  // 8 bytes
const MHBD_DB_ID_LEN      = 8;
const MHBD_HASH58_OFFSET  = 0x58;  // 20 bytes
const MHBD_HASH58_LEN     = 20;
const MHBD_HASH72_OFFSET  = 0x72;  // 46 bytes
const MHBD_HASH72_LEN     = 46;
const MHBD_HASHAB_OFFSET  = 0xAB;  // 57 bytes
const MHBD_HASHAB_LEN     = 57;
const MHBD_SCHEME_OFFSET  = 0x30;  // 2 bytes (hashing_scheme, LE)

/**
 * Recompute the HashAB signature inside an iTunesCDB buffer, in-place.
 *
 * @param {Uint8Array} data — the full iTunesCDB binary (modified in-place)
 * @param {Uint8Array} uuid — 8-byte FirewireGuid
 * @returns {Promise<Uint8Array>} — the same buffer, with hashAB patched
 */
export async function recomputeITunesCDBHash(data, uuid) {
    if (data.length < 0xAB + 57) {
        console.warn('[hashAB] iTunesCDB too small for hashAB recomputation');
        return data;
    }

    // Verify it's an mhbd header
    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== 'mhbd') {
        console.warn('[hashAB] iTunesCDB does not start with mhbd');
        return data;
    }

    // Set hashing_scheme to 3 (HashAB) — little-endian uint16
    data[MHBD_SCHEME_OFFSET] = 0x03;
    data[MHBD_SCHEME_OFFSET + 1] = 0x00;

    // Make a copy for SHA1 computation with fields zeroed
    const buf = new Uint8Array(data);
    buf.fill(0, MHBD_DB_ID_OFFSET, MHBD_DB_ID_OFFSET + MHBD_DB_ID_LEN);
    buf.fill(0, MHBD_HASH58_OFFSET, MHBD_HASH58_OFFSET + MHBD_HASH58_LEN);
    buf.fill(0, MHBD_HASH72_OFFSET, MHBD_HASH72_OFFSET + MHBD_HASH72_LEN);
    buf.fill(0, MHBD_HASHAB_OFFSET, MHBD_HASHAB_OFFSET + MHBD_HASHAB_LEN);

    // Compute SHA1 of the zeroed buffer
    const sha1Hash = await sha1(buf);

    // Compute HashAB
    const sig = calcHashAB(sha1Hash, uuid);

    // Patch the original data
    data.set(sig, MHBD_HASHAB_OFFSET);

    console.log(`[hashAB] Recomputed iTunesCDB hash (SHA1: ${hex(sha1Hash)}, sig[0:4]: ${hex(sig.slice(0, 4))})`);
    return data;
}

// ─── Locations.itdb.cbk ───
const CBK_BLOCK_SIZE   = 1024;
const CBK_HEADER_SIZE  = 57;  // HashAB signature
const CBK_SHA1_SIZE    = 20;

/**
 * Build a complete Locations.itdb.cbk from Locations.itdb data.
 *
 * Format:
 *   [57 bytes]  HashAB signature (over master SHA1)
 *   [20 bytes]  Master SHA1 = SHA1(concat of all block SHA1s)
 *   [N×20 bytes] SHA1 of each 1024-byte block
 *
 * @param {Uint8Array} locationsData — raw Locations.itdb file content
 * @param {Uint8Array} uuid — 8-byte FirewireGuid
 * @returns {Promise<Uint8Array>} — complete .cbk file
 */
export async function computeLocationsCBK(locationsData, uuid) {
    const numBlocks = Math.ceil(locationsData.length / CBK_BLOCK_SIZE);

    // SHA1 of each 1024-byte block
    const blockHashes = [];
    for (let i = 0; i < numBlocks; i++) {
        const start = i * CBK_BLOCK_SIZE;
        const end = Math.min(start + CBK_BLOCK_SIZE, locationsData.length);
        const block = locationsData.slice(start, end);
        // Pad to 1024 if last block is short (shouldn't happen for SQLite but be safe)
        let paddedBlock = block;
        if (block.length < CBK_BLOCK_SIZE) {
            paddedBlock = new Uint8Array(CBK_BLOCK_SIZE);
            paddedBlock.set(block);
        }
        const hash = await sha1(paddedBlock);
        blockHashes.push(hash);
    }

    // Master SHA1 = SHA1(concat of all block hashes)
    const allHashes = new Uint8Array(numBlocks * CBK_SHA1_SIZE);
    for (let i = 0; i < numBlocks; i++) {
        allHashes.set(blockHashes[i], i * CBK_SHA1_SIZE);
    }
    const masterSha1 = await sha1(allHashes);

    // HashAB signature over master SHA1
    const sig = calcHashAB(masterSha1, uuid);

    // Build cbk: [signature][master sha1][block hashes...]
    const cbkSize = CBK_HEADER_SIZE + CBK_SHA1_SIZE + numBlocks * CBK_SHA1_SIZE;
    const cbk = new Uint8Array(cbkSize);
    cbk.set(sig, 0);                           // 57-byte signature
    cbk.set(masterSha1, CBK_HEADER_SIZE);       // 20-byte master SHA1
    cbk.set(allHashes, CBK_HEADER_SIZE + CBK_SHA1_SIZE); // block hashes

    console.log(`[hashAB] Computed Locations.itdb.cbk: ${cbkSize} bytes, ` +
        `${numBlocks} blocks, master SHA1: ${hex(masterSha1)}, sig[0:4]: ${hex(sig.slice(0, 4))}`);
    return cbk;
}

/**
 * Parse a FirewireGuid hex string into an 8-byte Uint8Array.
 * @param {string} guidStr — e.g. "000A2700248F5308"
 * @returns {Uint8Array}
 */
export function parseUUID(guidStr) {
    const hex = guidStr.replace(/^0x/i, '');
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Hash58 (Checksum Type 1 — iPod Nano 3G/4G, Classic 6G/7G) ─────────────
// HMAC-SHA1 checksum with key derived from FirewireGuid using AES S-Box tables.
// Source: ipod-sharp Hash58.cs, libgpod itdb_hash58.c

// AES S-Box (table1) and Inverse S-Box (table2) — standard 256-byte lookup tables
/* eslint-disable comma-spacing */
const HASH58_TABLE1 = new Uint8Array([
    0x63,0x7C,0x77,0x7B,0xF2,0x6B,0x6F,0xC5,0x30,0x01,0x67,0x2B,0xFE,0xD7,0xAB,0x76,
    0xCA,0x82,0xC9,0x7D,0xFA,0x59,0x47,0xF0,0xAD,0xD4,0xA2,0xAF,0x9C,0xA4,0x72,0xC0,
    0xB7,0xFD,0x93,0x26,0x36,0x3F,0xF7,0xCC,0x34,0xA5,0xE5,0xF1,0x71,0xD8,0x31,0x15,
    0x04,0xC7,0x23,0xC3,0x18,0x96,0x05,0x9A,0x07,0x12,0x80,0xE2,0xEB,0x27,0xB2,0x75,
    0x09,0x83,0x2C,0x1A,0x1B,0x6E,0x5A,0xA0,0x52,0x3B,0xD6,0xB3,0x29,0xE3,0x2F,0x84,
    0x53,0xD1,0x00,0xED,0x20,0xFC,0xB1,0x5B,0x6A,0xCB,0xBE,0x39,0x4A,0x4C,0x58,0xCF,
    0xD0,0xEF,0xAA,0xFB,0x43,0x4D,0x33,0x85,0x45,0xF9,0x02,0x7F,0x50,0x3C,0x9F,0xA8,
    0x51,0xA3,0x40,0x8F,0x92,0x9D,0x38,0xF5,0xBC,0xB6,0xDA,0x21,0x10,0xFF,0xF3,0xD2,
    0xCD,0x0C,0x13,0xEC,0x5F,0x97,0x44,0x17,0xC4,0xA7,0x7E,0x3D,0x64,0x5D,0x19,0x73,
    0x60,0x81,0x4F,0xDC,0x22,0x2A,0x90,0x88,0x46,0xEE,0xB8,0x14,0xDE,0x5E,0x0B,0xDB,
    0xE0,0x32,0x3A,0x0A,0x49,0x06,0x24,0x5C,0xC2,0xD3,0xAC,0x62,0x91,0x95,0xE4,0x79,
    0xE7,0xC8,0x37,0x6D,0x8D,0xD5,0x4E,0xA9,0x6C,0x56,0xF4,0xEA,0x65,0x7A,0xAE,0x08,
    0xBA,0x78,0x25,0x2E,0x1C,0xA6,0xB4,0xC6,0xE8,0xDD,0x74,0x1F,0x4B,0xBD,0x8B,0x8A,
    0x70,0x3E,0xB5,0x66,0x48,0x03,0xF6,0x0E,0x61,0x35,0x57,0xB9,0x86,0xC1,0x1D,0x9E,
    0xE1,0xF8,0x98,0x11,0x69,0xD9,0x8E,0x94,0x9B,0x1E,0x87,0xE9,0xCE,0x55,0x28,0xDF,
    0x8C,0xA1,0x89,0x0D,0xBF,0xE6,0x42,0x68,0x41,0x99,0x2D,0x0F,0xB0,0x54,0xBB,0x16,
]);
const HASH58_TABLE2 = new Uint8Array([
    0x52,0x09,0x6A,0xD5,0x30,0x36,0xA5,0x38,0xBF,0x40,0xA3,0x9E,0x81,0xF3,0xD7,0xFB,
    0x7C,0xE3,0x39,0x82,0x9B,0x2F,0xFF,0x87,0x34,0x8E,0x43,0x44,0xC4,0xDE,0xE9,0xCB,
    0x54,0x7B,0x94,0x32,0xA6,0xC2,0x23,0x3D,0xEE,0x4C,0x95,0x0B,0x42,0xFA,0xC3,0x4E,
    0x08,0x2E,0xA1,0x66,0x28,0xD9,0x24,0xB2,0x76,0x5B,0xA2,0x49,0x6D,0x8B,0xD1,0x25,
    0x72,0xF8,0xF6,0x64,0x86,0x68,0x98,0x16,0xD4,0xA4,0x5C,0xCC,0x5D,0x65,0xB6,0x92,
    0x6C,0x70,0x48,0x50,0xFD,0xED,0xB9,0xDA,0x5E,0x15,0x46,0x57,0xA7,0x8D,0x9D,0x84,
    0x90,0xD8,0xAB,0x00,0x8C,0xBC,0xD3,0x0A,0xF7,0xE4,0x58,0x05,0xB8,0xB3,0x45,0x06,
    0xD0,0x2C,0x1E,0x8F,0xCA,0x3F,0x0F,0x02,0xC1,0xAF,0xBD,0x03,0x01,0x13,0x8A,0x6B,
    0x3A,0x91,0x11,0x41,0x4F,0x67,0xDC,0xEA,0x97,0xF2,0xCF,0xCE,0xF0,0xB4,0xE6,0x73,
    0x96,0xAC,0x74,0x22,0xE7,0xAD,0x35,0x85,0xE2,0xF9,0x37,0xE8,0x1C,0x75,0xDF,0x6E,
    0x47,0xF1,0x1A,0x71,0x1D,0x29,0xC5,0x89,0x6F,0xB7,0x62,0x0E,0xAA,0x18,0xBE,0x1B,
    0xFC,0x56,0x3E,0x4B,0xC6,0xD2,0x79,0x20,0x9A,0xDB,0xC0,0xFE,0x78,0xCD,0x5A,0xF4,
    0x1F,0xDD,0xA8,0x33,0x88,0x07,0xC7,0x31,0xB1,0x12,0x10,0x59,0x27,0x80,0xEC,0x5F,
    0x60,0x51,0x7F,0xA9,0x19,0xB5,0x4A,0x0D,0x2D,0xE5,0x7A,0x9F,0x93,0xC9,0x9C,0xEF,
    0xA0,0xE0,0x3B,0x4D,0xAE,0x2A,0xF5,0xB0,0xC8,0xEB,0xBB,0x3C,0x83,0x53,0x99,0x61,
    0x17,0x2B,0x04,0x7E,0xBA,0x77,0xD6,0x26,0xE1,0x69,0x14,0x63,0x55,0x21,0x0C,0x7D,
]);
/* eslint-enable comma-spacing */
const HASH58_FIXED = new Uint8Array([
    0x67, 0x23, 0xFE, 0x30, 0x45, 0x33, 0xF8, 0x90,
    0x99, 0x21, 0x07, 0xC1, 0xD0, 0x12, 0xB2, 0xA1, 0x07, 0x81,
]);

const MHBD_UNK32_OFFSET = 0x32;
const MHBD_UNK32_LEN    = 20;

function gcd(a, b) {
    while (true) {
        a = a % b;
        if (a === 0) return b;
        b = b % a;
        if (b === 0) return a;
    }
}

function lcm(a, b) {
    return (a === 0 || b === 0) ? 1 : Math.floor((a * b) / gcd(a, b));
}

/**
 * Derive a 20-byte HMAC key from the 8-byte FirewireGuid.
 * Algorithm: for each pair of FWID bytes, compute LCM, split into hi/lo,
 * look up in AES S-Box/Inverse S-Box, then SHA-1(fixed + derived_bytes).
 */
async function generateHash58Key(fwid) {
    const y = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
        const l = lcm(fwid[i * 2], fwid[i * 2 + 1]);
        const hi = (l >> 8) & 0xFF;
        const lo = l & 0xFF;
        y[i * 4]     = HASH58_TABLE1[hi];
        y[i * 4 + 1] = HASH58_TABLE2[hi];
        y[i * 4 + 2] = HASH58_TABLE1[lo];
        y[i * 4 + 3] = HASH58_TABLE2[lo];
    }
    // SHA-1(HASH58_FIXED + y) → 20-byte key
    const combined = new Uint8Array(HASH58_FIXED.length + y.length);
    combined.set(HASH58_FIXED, 0);
    combined.set(y, HASH58_FIXED.length);
    return await sha1(combined);
}

/**
 * Recompute the Hash58 (HMAC-SHA1) checksum inside an iTunesDB buffer, in-place.
 *
 * Used for iPod Nano 3G/4G and Classic 6G/7G (checksum type 1).
 * These devices verify the iTunesDB integrity via HMAC-SHA1 using the
 * FirewireGuid as key material. After binary-patching the iTunesDB
 * (e.g. to set has_artwork flags), the hash must be recomputed.
 *
 * @param {Uint8Array} data — the full iTunesDB binary (modified in-place)
 * @param {Uint8Array} uuid — 8-byte FirewireGuid (from parseUUID)
 * @returns {Promise<Uint8Array>} — the same buffer, with hash58 patched
 */
export async function recomputeHash58(data, uuid) {
    if (data.length < MHBD_HASH58_OFFSET + MHBD_HASH58_LEN) {
        console.warn('[hash58] iTunesDB too small for hash58 recomputation');
        return data;
    }

    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== 'mhbd') {
        console.warn('[hash58] iTunesDB does not start with mhbd');
        return data;
    }

    // Derive HMAC key from FirewireGuid
    const hmacKey = await generateHash58Key(uuid);

    // Make a copy with hash-relevant fields zeroed (per libgpod itdb_hash58.c)
    const buf = new Uint8Array(data);
    buf.fill(0, MHBD_DB_ID_OFFSET, MHBD_DB_ID_OFFSET + MHBD_DB_ID_LEN);
    buf.fill(0, MHBD_UNK32_OFFSET, MHBD_UNK32_OFFSET + MHBD_UNK32_LEN);
    buf.fill(0, MHBD_HASH58_OFFSET, MHBD_HASH58_OFFSET + MHBD_HASH58_LEN);

    // Set hashing_scheme to 1 in the copy (should already be 1, but be explicit)
    buf[MHBD_SCHEME_OFFSET] = 0x01;
    buf[MHBD_SCHEME_OFFSET + 1] = 0x00;

    // Compute HMAC-SHA1 using Web Crypto API
    const cryptoKey = await crypto.subtle.importKey(
        'raw', hmacKey, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, buf);
    const hash = new Uint8Array(sig);

    // Write hash back to original data at offset 0x58
    data.set(hash, MHBD_HASH58_OFFSET);

    console.log(`[hash58] Recomputed iTunesDB hash58 (${hex(hash)})`);
    return data;
}
