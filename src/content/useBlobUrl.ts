import { useEffect, useState } from "react";

export interface BlobUrlFactory {
  readonly create: (blob: Blob) => string;
  readonly revoke: (url: string) => void;
}

export const browserBlobUrls: BlobUrlFactory = Object.freeze({
  create: (blob: Blob) => URL.createObjectURL(blob),
  revoke: (url: string) => URL.revokeObjectURL(url),
});

export function useBlobUrl(
  blob: Blob | null,
  factory: BlobUrlFactory = browserBlobUrls,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const next = factory.create(blob);
    setUrl(next);
    return () => {
      factory.revoke(next);
    };
  }, [blob, factory]);

  return url;
}
