import type { TenantStorageAccount } from "../../domain/types.js";
import type {
  CommitOutcome,
  ReserveOutcome,
  TenantStorageAccountRepository,
} from "../../application/ports.js";
import { clone, tick } from "./utils.js";

/**
 * Every quota mutation is a synchronous check-and-set after the async I/O
 * boundary, so interleaved callers can never both pass the same check.
 * PostgreSQL equivalent for reserveBytes:
 *
 *   UPDATE tenant_storage_accounts
 *      SET reserved_bytes = reserved_bytes + $amount
 *    WHERE tenant_id = $tenant
 *      AND used_bytes + reserved_bytes + $amount <= limit_bytes
 *   -- zero affected rows => quota exceeded
 */
export class InMemoryTenantStorageAccountRepository
  implements TenantStorageAccountRepository
{
  private readonly accounts = new Map<string, TenantStorageAccount>();

  constructor(accounts: readonly TenantStorageAccount[] = []) {
    for (const account of accounts) {
      this.accounts.set(account.tenantId, clone(account));
    }
  }

  async reserveBytes(
    tenantId: string,
    amountBytes: number,
  ): Promise<ReserveOutcome> {
    await tick();
    const account = this.accounts.get(tenantId);
    if (!account) {
      return { kind: "tenant-not-found" };
    }
    if (account.usedBytes + account.reservedBytes + amountBytes > account.limitBytes) {
      return { kind: "quota-exceeded" };
    }
    account.reservedBytes += amountBytes;
    return { kind: "reserved", account: clone(account) };
  }

  async releaseBytes(tenantId: string, amountBytes: number): Promise<void> {
    await tick();
    const account = this.accounts.get(tenantId);
    if (!account) {
      throw new Error(`invariant violation: missing account for tenant ${tenantId}`);
    }
    if (account.reservedBytes < amountBytes) {
      throw new Error(
        `invariant violation: release of ${amountBytes} exceeds reserved ${account.reservedBytes}`,
      );
    }
    account.reservedBytes -= amountBytes;
  }

  async commitBytes(
    tenantId: string,
    amountBytes: number,
  ): Promise<CommitOutcome> {
    await tick();
    const account = this.accounts.get(tenantId);
    if (!account) {
      return { kind: "tenant-not-found" };
    }
    if (account.reservedBytes < amountBytes) {
      throw new Error(
        `invariant violation: commit of ${amountBytes} exceeds reserved ${account.reservedBytes}`,
      );
    }
    account.reservedBytes -= amountBytes;
    account.usedBytes += amountBytes;
    return { kind: "committed", account: clone(account) };
  }

  /** Test/ops helper: point-in-time copy of an account. Not part of the port. */
  snapshot(tenantId: string): TenantStorageAccount | null {
    const account = this.accounts.get(tenantId);
    return account ? clone(account) : null;
  }
}
