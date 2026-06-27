/**
 * In-memory credential store with AES-256-GCM encryption.
 *
 * For production, replace the Map with an OCI Vault-backed or
 * Redis-based store. The encryption layer stays the same either way.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config.js';
import type { StoredUser, OracleConnectionConfig } from '../types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(config.encryption.key, 'hex');

function encrypt(plaintext: string): string {
  const iv  = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
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

// userId → encrypted StoredUser JSON
const store = new Map<string, string>();

export function saveUser(user: StoredUser): void {
  store.set(user.userId, encrypt(JSON.stringify(user)));
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
