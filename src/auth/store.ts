/**
 * Credential store with AES-256-GCM encryption + disk persistence.
 *
 * Encrypted blobs are loaded from disk at startup and written back on every
 * save. Set ORALINK_DATA_DIR (default: .data) to control where data lives.
 * This is critical for the API key path: without persistence, add_connection
 * must be called again after every server restart.
 *
 * What is stored on disk: only AES-256-GCM encrypted blobs. Without the
 * matching ENCRYPTION_KEY, the file is unreadable. The store file is written
 * with mode 0o600 (owner read/write only); the directory is created 0o700.
 *
 * For production at scale, swap the Map for an OCI Vault-backed or Redis
 * store. The encryption layer stays the same either way.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import type { StoredUser, OracleConnectionConfig } from '../types.js';

const ALGORITHM  = 'aes-256-gcm';
const KEY        = Buffer.from(config.encryption.key, 'hex');
const DATA_DIR   = config.data.dir;
const STORE_FILE = join(DATA_DIR, 'store.json');

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

function encrypt(plaintext: string): string {
  const iv        = randomBytes(12);
  const cipher    = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const iv        = Buffer.from(ivHex,  'hex');
  const tag       = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher  = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ── Disk persistence ──────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadFromDisk(): Map<string, string> {
  try {
    ensureDataDir();
    if (!existsSync(STORE_FILE)) return new Map();
    const obj = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [userId, blob] of Object.entries(obj)) {
      try {
        decrypt(blob);       // validate — skip entries that can't be decrypted with current key
        map.set(userId, blob);
      } catch {
        /* corrupted or key-mismatch — silently skip */
      }
    }
    return map;
  } catch {
    return new Map();        // missing/corrupt file — start fresh
  }
}

function saveToDisk(map: Map<string, string>): void {
  try {
    ensureDataDir();
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
  } catch {
    /* non-fatal — data is live in memory for this session */
  }
}

// ── In-memory store (bootstrapped from disk at module load) ───────────────────
// userId → encrypted StoredUser JSON
const store = loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function saveUser(user: StoredUser): void {
  store.set(user.userId, encrypt(JSON.stringify(user)));
  saveToDisk(store);
}

export function loadUser(userId: string): StoredUser | null {
  const enc = store.get(userId);
  if (!enc) return null;
  return JSON.parse(decrypt(enc)) as StoredUser;
}

export function upsertConnection(
  userId: string,
  connectionName: string,
  conn: OracleConnectionConfig,
): StoredUser {
  const user: StoredUser = loadUser(userId) ?? {
    userId,
    connections: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  user.connections[connectionName] = conn;
  user.updatedAt = Date.now();
  saveUser(user);
  return user;
}

export function deleteConnection(userId: string, connectionName: string): boolean {
  const user = loadUser(userId);
  if (!user || !user.connections[connectionName]) return false;
  delete user.connections[connectionName];
  saveUser(user);
  return true;
}

export function listConnections(userId: string): string[] {
  const user = loadUser(userId);
  return user ? Object.keys(user.connections) : [];
}
