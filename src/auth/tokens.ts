import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import type { OAuthTokenPayload } from '../types.js';

export function generateUserId(): string {
  return randomUUID();
}

export function signAccessToken(userId: string): string {
  const payload: OAuthTokenPayload = {
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + config.oauth.tokenExpiry,
    type: 'access',
  };
  return jwt.sign(payload, config.oauth.jwtSecret);
}

export function signRefreshToken(userId: string): string {
  const payload: OAuthTokenPayload = {
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + config.oauth.refreshTokenExpiry,
    type: 'refresh',
  };
  return jwt.sign(payload, config.oauth.jwtSecret);
}

export function verifyToken(token: string): OAuthTokenPayload {
  return jwt.verify(token, config.oauth.jwtSecret) as OAuthTokenPayload;
}

export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim();
}
