// PixSync Upload Session Core — end-to-end demo.
// Run with: npm run demo
//
// This core is a backend library: it has no login screen or credentials.
// The "default access data" below are the seeded demo tenant, provider,
// gallery, and storage quota used throughout the walkthrough.

import {
  AppError,
  FixedClock,
  InMemoryGalleryRepository,
  InMemoryTenantStorageAccountRepository,
  InMemoryUploadSessionRepository,
  SequenceIdGenerator,
  createUploadSessionCore,
} from "../dist/index.js";

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Default seed data (the demo "environment")
// ---------------------------------------------------------------------------
const DEFAULT_SEED = {
  tenantId: "t-1",
  providerId: "p-1",
  galleryId: "g-1",
  storageLimitBytes: 100 * MB,
};

const clock = new FixedClock(Date.parse("2026-01-01T00:00:00Z"));
const ids = new SequenceIdGenerator("demo");
const accounts = new InMemoryTenantStorageAccountRepository([
  {
    tenantId: DEFAULT_SEED.tenantId,
    limitBytes: DEFAULT_SEED.storageLimitBytes,
    usedBytes: 0,
    reservedBytes: 0,
  },
]);

const core = createUploadSessionCore({
  galleries: new InMemoryGalleryRepository([
    {
      id: DEFAULT_SEED.galleryId,
      tenantId: DEFAULT_SEED.tenantId,
      providerId: DEFAULT_SEED.providerId,
      status: "ACTIVE",
    },
  ]),
  accounts,
  sessions: new InMemoryUploadSessionRepository(),
  ids,
  clock,
});

function line(title) {
  console.log(`\n=== ${title} ===`);
}

function showAccount() {
  const account = accounts.snapshot(DEFAULT_SEED.tenantId);
  console.log(
    `tenant ${DEFAULT_SEED.tenantId}: ` +
      `used=${(account.usedBytes / MB).toFixed(1)}MB ` +
      `reserved=${(account.reservedBytes / MB).toFixed(1)}MB ` +
      `limit=${(account.limitBytes / MB).toFixed(1)}MB`,
  );
}

const files = [
  {
    clientFileId: "f-1",
    fileName: "sunset-beach.JPG",
    sizeBytes: 12 * MB,
    sha256: "a".repeat(64),
  },
  {
    clientFileId: "f-2",
    fileName: "family-portrait.png",
    sizeBytes: 8 * MB,
    sha256: "b".repeat(64),
  },
];

line("1. Create an upload session (20 MB reserved, expires in 15 min)");
const session = await core.createUploadSession({
  tenantId: DEFAULT_SEED.tenantId,
  providerId: DEFAULT_SEED.providerId,
  galleryId: DEFAULT_SEED.galleryId,
  idempotencyKey: "demo-key-1",
  files,
});
console.log(`session ${session.id} status=${session.status}`);
console.log(`expires ${Math.round((session.expiresAt - session.createdAt) / 60000)} min after creation`);
for (const file of session.files) {
  console.log(`  ${file.clientFileId} -> ${file.objectKey}`);
}
showAccount();

line("2. Idempotent replay returns the SAME session (no double reservation)");
const replay = await core.createUploadSession({
  tenantId: DEFAULT_SEED.tenantId,
  providerId: DEFAULT_SEED.providerId,
  galleryId: DEFAULT_SEED.galleryId,
  idempotencyKey: "demo-key-1",
  files,
});
console.log(`same id? ${replay.id === session.id}`);
showAccount();

line("3. Reusing the key with a different payload -> IDEMPOTENCY_CONFLICT");
try {
  await core.createUploadSession({
    tenantId: DEFAULT_SEED.tenantId,
    providerId: DEFAULT_SEED.providerId,
    galleryId: DEFAULT_SEED.galleryId,
    idempotencyKey: "demo-key-1",
    files: [{ ...files[0], sizeBytes: 99 * MB }],
  });
} catch (error) {
  console.log(
    `rejected with code=${error instanceof AppError ? error.code : "?"}`,
  );
}

line("4. Complete the session -> reserved bytes move to used bytes");
const completed = await core.completeUploadSession(
  DEFAULT_SEED.tenantId,
  session.id,
  ["f-1", "f-2"],
);
console.log(`status=${completed.status}`);
showAccount();

line("5. A second 95 MB request now exceeds the remaining quota");
try {
  await core.createUploadSession({
    tenantId: DEFAULT_SEED.tenantId,
    providerId: DEFAULT_SEED.providerId,
    galleryId: DEFAULT_SEED.galleryId,
    idempotencyKey: "demo-key-2",
    files: [
      {
        clientFileId: "f-3",
        fileName: "huge-video-frame.webp",
        sizeBytes: 95 * MB,
        sha256: "c".repeat(64),
      },
    ],
  });
} catch (error) {
  console.log(
    `rejected with code=${error instanceof AppError ? error.code : "?"}`,
  );
}

line("6. Cancel a new session -> reservation is released");
const toCancel = await core.createUploadSession({
  tenantId: DEFAULT_SEED.tenantId,
  providerId: DEFAULT_SEED.providerId,
  galleryId: DEFAULT_SEED.galleryId,
  idempotencyKey: "demo-key-3",
  files: [
    {
      clientFileId: "f-4",
      fileName: "selfie.heic",
      sizeBytes: 5 * MB,
      sha256: "d".repeat(64),
    },
  ],
});
await core.cancelUploadSession(DEFAULT_SEED.tenantId, toCancel.id);
showAccount();
