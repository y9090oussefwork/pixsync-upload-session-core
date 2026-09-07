import type { UploadSession } from "../domain/types.js";
import { CancelUploadSession } from "./cancel-upload-session.js";
import { CreateUploadSession } from "./create-upload-session.js";
import { CompleteUploadSession } from "./complete-upload-session.js";
import type {
  Clock,
  GalleryRepository,
  IdGenerator,
  TenantStorageAccountRepository,
  UploadSessionRepository,
} from "./ports.js";
import type { CreateUploadSessionCommand } from "./create-upload-session.js";

export interface UploadSessionCoreDeps {
  galleries: GalleryRepository;
  accounts: TenantStorageAccountRepository;
  sessions: UploadSessionRepository;
  ids: IdGenerator;
  clock: Clock;
}

/**
 * Composition root: wires the use cases against injected ports. Swapping the
 * in-memory repositories for PostgreSQL-backed ones requires no change here.
 */
export function createUploadSessionCore(deps: UploadSessionCoreDeps) {
  const create = new CreateUploadSession(deps);
  const cancel = new CancelUploadSession(deps);
  const complete = new CompleteUploadSession(deps);
  return {
    createUploadSession(
      command: CreateUploadSessionCommand,
    ): Promise<UploadSession> {
      return create.execute(command);
    },
    cancelUploadSession(
      tenantId: string,
      sessionId: string,
    ): Promise<UploadSession> {
      return cancel.execute(tenantId, sessionId);
    },
    completeUploadSession(
      tenantId: string,
      sessionId: string,
      confirmedClientFileIds: readonly string[],
    ): Promise<UploadSession> {
      return complete.execute(tenantId, sessionId, confirmedClientFileIds);
    },
  };
}

export type UploadSessionCore = ReturnType<typeof createUploadSessionCore>;
