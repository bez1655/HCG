/**
 * ============================================================================
 * FIRESTORE ACCESS LAYER
 * ============================================================================
 *
 * The server used to talk to Firestore through the **client** SDK, which is
 * subject to security rules. That is why `/game/{docId}` had to be world
 * writable (`allow read, write: if true`) — and why anyone holding the public
 * web API key could read every password hash and rewrite the game state.
 *
 * This module switches the server to the **Admin SDK**, which authenticates
 * with a service account and bypasses security rules entirely. Firestore rules
 * can therefore stay fully closed (`if false`).
 *
 * Credential resolution order:
 *   1. FIREBASE_SERVICE_ACCOUNT       — the JSON key itself (env var / secret)
 *   2. GOOGLE_APPLICATION_CREDENTIALS — path to a JSON key file
 *   3. Application Default Credentials — attached service account on GCP,
 *      Cloud Run, GKE, or a local `gcloud auth application-default login`
 *
 * When no credential is available the module stays disabled and the server
 * falls back to local disk persistence, exactly as before.
 */
import fs from "node:fs";
import { initializeApp, cert, applicationDefault, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { createLogger, errorContext } from "../utils/logger";

const log = createLogger("Firestore");

export interface FirestoreInitOptions {
  projectId?: string;
  databaseId?: string;
  /** Raw service-account JSON (contents, not a path). */
  serviceAccountJson?: string;
  /** Filesystem path to a service-account JSON key. */
  serviceAccountPath?: string;
}

export type FirestoreStatus = "disabled" | "connected" | "quota-exceeded" | "error";

let app: App | null = null;
let db: Firestore | null = null;
let status: FirestoreStatus = "disabled";
let quotaExceeded = false;
let credentialSource = "none";

/** True when Firestore is usable for reads/writes right now. */
export function isEnabled(): boolean {
  return db !== null && !quotaExceeded;
}

export function getStatus(): FirestoreStatus {
  if (!db) return "disabled";
  return quotaExceeded ? "quota-exceeded" : status;
}

export function getCredentialSource(): string {
  return credentialSource;
}

function parseServiceAccount(raw: string, origin: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
      log.error("Service account is missing required fields", {
        origin,
        required: "project_id, private_key, client_email",
      });
      return null;
    }
    return parsed;
  } catch (err) {
    log.error(`Service account from ${origin} is not valid JSON.`);
    return null;
  }
}

/**
 * Initialise the Admin SDK. Safe to call once at boot; returns false when no
 * credential is configured so the caller can fall back to disk persistence.
 */
export function initFirestore(options: FirestoreInitOptions): boolean {
  if (db) return true;

  let credential;
  let projectId = options.projectId;

  // 1. Inline service-account JSON (secret manager / env var)
  if (options.serviceAccountJson) {
    const sa = parseServiceAccount(options.serviceAccountJson, "FIREBASE_SERVICE_ACCOUNT");
    if (sa) {
      credential = cert(sa as any);
      projectId = projectId || (sa.project_id as string);
      credentialSource = "FIREBASE_SERVICE_ACCOUNT";
    }
  }

  // 2. Service-account key file
  if (!credential && options.serviceAccountPath) {
    if (!fs.existsSync(options.serviceAccountPath)) {
      log.error("GOOGLE_APPLICATION_CREDENTIALS points to a missing file", {
        path: options.serviceAccountPath,
      });
    } else {
      const sa = parseServiceAccount(
        fs.readFileSync(options.serviceAccountPath, "utf8"),
        options.serviceAccountPath
      );
      if (sa) {
        credential = cert(sa as any);
        projectId = projectId || (sa.project_id as string);
        credentialSource = "GOOGLE_APPLICATION_CREDENTIALS";
      }
    }
  }

  // 3. Application Default Credentials (Cloud Run / GKE / gcloud login).
  //    ADC only makes sense when a project id can actually be resolved:
  //    applicationDefault() succeeds lazily even with no credential at all and
  //    then fails on every single request, which would leave the server
  //    reporting "connected" while nothing works.
  if (!credential) {
    const adcProjectId =
      projectId ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      process.env.GCP_PROJECT;

    if (adcProjectId) {
      try {
        credential = applicationDefault();
        projectId = adcProjectId;
        credentialSource = "application-default";
      } catch {
        credential = undefined;
      }
    }
  }

  if (!credential) {
    log.warn(
      "No service-account credential found — running with local disk persistence. " +
        "Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS to enable Firestore."
    );
    status = "disabled";
    return false;
  }

  try {
    app = initializeApp({ credential, projectId });
    const databaseId = options.databaseId?.trim();
    db =
      databaseId && databaseId !== "(default)" ? getFirestore(app, databaseId) : getFirestore(app);

    // Never write `undefined` values; they would throw on save.
    db.settings({ ignoreUndefinedProperties: true });

    status = "connected";
    log.info("Admin SDK initialised; security rules are bypassed by design", {
      database: databaseId || "(default)",
      credential: credentialSource,
    });
    return true;
  } catch (err) {
    log.error("Failed to initialise the Admin SDK", errorContext(err));
    status = "error";
    db = null;
    return false;
  }
}

/** Detects quota exhaustion so the caller can degrade to disk persistence. */
function isQuotaError(err: any): boolean {
  const msg = String(err?.message || err || "");
  const code = err?.code;
  return (
    code === 8 ||
    code === "resource-exhausted" ||
    code === "RESOURCE_EXHAUSTED" ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("Quota limit exceeded") ||
    msg.includes("quota limits are reset")
  );
}

function handleError(err: any, operation: string): void {
  if (isQuotaError(err)) {
    if (!quotaExceeded) {
      quotaExceeded = true;
      log.warn("Quota exhausted — switching to local disk persistence", { operation });
    }
    return;
  }
  log.error("Operation failed", { operation, ...errorContext(err) });
}

/** Read a document from the `game` collection. Returns null when unavailable. */
export async function readDoc<T = Record<string, any>>(docId: string): Promise<T | null> {
  if (!isEnabled() || !db) return null;
  try {
    const snap = await db.collection("game").doc(docId).get();
    return snap.exists ? (snap.data() as T) : null;
  } catch (err) {
    handleError(err, `read of game/${docId}`);
    return null;
  }
}

/** Write a document to the `game` collection. Returns true on success. */
export async function writeDoc(docId: string, data: Record<string, any>): Promise<boolean> {
  if (!isEnabled() || !db) return false;
  try {
    await db.collection("game").doc(docId).set(data);
    return true;
  } catch (err) {
    handleError(err, `write of game/${docId}`);
    return false;
  }
}

/** Write several documents atomically, so state and credentials stay in sync. */
export async function writeBatch(docs: Record<string, Record<string, any>>): Promise<boolean> {
  if (!isEnabled() || !db) return false;
  try {
    const batch = db.batch();
    for (const [docId, data] of Object.entries(docs)) {
      batch.set(db.collection("game").doc(docId), data);
    }
    await batch.commit();
    return true;
  } catch (err) {
    handleError(err, `batch write of ${Object.keys(docs).join(", ")}`);
    return false;
  }
}

/**
 * Confirm the credential actually works before the server relies on it.
 * Without this a misconfigured deployment reports "connected" and then fails
 * on every request, silently losing writes that were assumed to be durable.
 */
export async function verifyConnection(): Promise<boolean> {
  if (!db) return false;
  try {
    await db.collection("game").doc("__healthcheck").get();
    log.info("Connection verified — reads and writes are live");
    return true;
  } catch (err: any) {
    status = "error";
    db = null;
    log.error(
      "Credential present but unusable — falling back to local disk persistence. " +
        "Check the service account, project id and that the Firestore API is enabled.",
      errorContext(err)
    );
    return false;
  }
}

/**
 * Read-modify-write a document inside a Firestore transaction.
 *
 * Plain writeDoc()/writeBatch() overwrite the whole document, so two server
 * instances (a rolling deploy, or an accidental second process) silently clob
 * each other's changes. A transaction re-reads the document and retries on
 * conflict, which is what makes concurrent updates safe.
 *
 * @param docId   Document inside the `game` collection.
 * @param mutate  Receives the current data (null when absent) and returns the
 *                value to store. Must be pure — it can run several times.
 */
export async function updateInTransaction<T extends Record<string, any>>(
  docId: string,
  mutate: (current: T | null) => T
): Promise<boolean> {
  if (!isEnabled() || !db) return false;
  const ref = db.collection("game").doc(docId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() as T) : null;
      tx.set(ref, mutate(current));
    });
    return true;
  } catch (err) {
    handleError(err, `transactional update of game/${docId}`);
    return false;
  }
}

/** Merge-update a document (used for the calibration map). */
export async function mergeDoc(docId: string, data: Record<string, any>): Promise<boolean> {
  if (!isEnabled() || !db) return false;
  try {
    await db.collection("game").doc(docId).set(data, { merge: true });
    return true;
  } catch (err) {
    handleError(err, `merge of game/${docId}`);
    return false;
  }
}
