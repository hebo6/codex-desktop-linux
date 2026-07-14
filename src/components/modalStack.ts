import { useCallback, useLayoutEffect, useRef } from "react";

const modalLayers: symbol[] = [];

export function useModalLayer(active = true): () => boolean {
  const tokenRef = useRef(Symbol("modal-layer"));

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const token = tokenRef.current;
    modalLayers.push(token);
    return () => {
      const index = modalLayers.lastIndexOf(token);
      if (index >= 0) {
        modalLayers.splice(index, 1);
      }
    };
  }, [active]);

  return useCallback(() => modalLayers.at(-1) === tokenRef.current, []);
}
