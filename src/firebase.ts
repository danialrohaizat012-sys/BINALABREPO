// Firebase Admin: lets the server verify who is calling from BinaLab Studio
// and write payment status back into the same Firestore that Studio reads.
import { initializeApp, cert, applicationDefault, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Request, Response, NextFunction } from 'express';

// FIREBASE_SERVICE_ACCOUNT holds the service-account JSON (plain or base64).
// Without it, Google's default credentials are used (e.g. on Cloud Run).
function credential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) return applicationDefault();
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return cert(JSON.parse(json) as ServiceAccount);
}

const configured = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.K_SERVICE);
const app = configured ? initializeApp({ credential: credential(), projectId: process.env.FIREBASE_PROJECT_ID }) : null;

export let db: Firestore | null = app ? getFirestore(app) : null;

// For local tests only: point the routes at another Firestore-like store.
export function setFirestoreForTests(store: Firestore) {
  db = store;
}

// Only these Studio logins may create or void payment links.
const admins = (process.env.STUDIO_ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export async function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (!app) {
    res.status(503).json({ error: 'Firebase Admin is not configured on the server.' });
    return;
  }
  const token = req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) {
    res.status(401).json({ error: 'Sign in to Studio first.' });
    return;
  }
  try {
    const user = await getAuth(app).verifyIdToken(token);
    const email = user.email?.toLowerCase() ?? '';
    if (!admins.length || !admins.includes(email)) {
      res.status(403).json({ error: 'This account is not allowed to manage payments.' });
      return;
    }
    res.locals.staffEmail = email;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Sign in to Studio again.' });
  }
}
