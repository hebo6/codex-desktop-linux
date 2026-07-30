import { useCallback, useState } from "react";

import type { ProxyEditorSubmission } from "../components/proxyEditorModel";
import type { ServerEditorSubmission } from "../components/serverEditorModel";
import type { CredentialStorageStatus } from "../configuration";

export type CredentialStorageStatusLoader =
  () => Promise<CredentialStorageStatus>;

export type PendingPlaintextCredentialConfirmation =
  | {
      readonly kind: "server";
      readonly submission: ServerEditorSubmission;
    }
  | {
      readonly kind: "proxy";
      readonly submission: ProxyEditorSubmission;
    };

export interface PlaintextCredentialConfirmationControls {
  readonly checking: boolean;
  readonly pending: PendingPlaintextCredentialConfirmation | null;
  readonly prepare: (
    pending: PendingPlaintextCredentialConfirmation,
  ) => Promise<boolean>;
  readonly request: (
    pending: PendingPlaintextCredentialConfirmation,
  ) => void;
  readonly confirm: () => PendingPlaintextCredentialConfirmation | null;
  readonly clear: (kind?: PendingPlaintextCredentialConfirmation["kind"]) => void;
}

export function usePlaintextCredentialConfirmation(
  loadStorageStatus: CredentialStorageStatusLoader,
): PlaintextCredentialConfirmationControls {
  const [checking, setChecking] = useState(false);
  const [pending, setPending] =
    useState<PendingPlaintextCredentialConfirmation | null>(null);

  const prepare = useCallback(async (
    candidate: PendingPlaintextCredentialConfirmation,
  ): Promise<boolean> => {
    if (candidate.submission.credentialIntent.type !== "set") {
      return true;
    }

    setChecking(true);
    let confirmationRequired = false;
    try {
      const status = await loadStorageStatus();
      confirmationRequired = status.backend === "plaintextFile";
    } catch {
      // The Rust write boundary still denies an unconfirmed plaintext fallback.
    } finally {
      setChecking(false);
    }

    if (confirmationRequired) {
      setPending(candidate);
      return false;
    }
    return true;
  }, [loadStorageStatus]);

  const request = useCallback((
    candidate: PendingPlaintextCredentialConfirmation,
  ) => {
    setPending(candidate);
  }, []);

  const confirm = useCallback(() => {
    const confirmed = pending;
    setPending(null);
    return confirmed;
  }, [pending]);

  const clear = useCallback((
    kind?: PendingPlaintextCredentialConfirmation["kind"],
  ) => {
    setPending((current) =>
      kind === undefined || current?.kind === kind ? null : current
    );
  }, []);

  return {
    checking,
    pending,
    prepare,
    request,
    confirm,
    clear,
  };
}
