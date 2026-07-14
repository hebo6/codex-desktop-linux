import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_APP_PREFERENCES,
  preferencesStore,
  type AppPreferences,
  type PreferencesStore,
} from "../transport/preferences";

export function usePreferences(store: PreferencesStore = preferencesStore) {
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const saveTailRef = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    void store.load().then(
      (loaded) => {
        if (!active) return;
        currentRef.current = loaded;
        setPreferences(loaded);
        setLoading(false);
        setError(null);
      },
      () => {
        if (!active) return;
        setLoading(false);
        setError("无法加载偏好设置，当前使用默认值");
      },
    );
    return () => { active = false; };
  }, [store]);

  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  const update = useCallback((patch: Partial<AppPreferences>) => {
    const next = Object.freeze({ ...currentRef.current, ...patch });
    currentRef.current = next;
    setPreferences(next);
    setSaving(true);
    setError(null);
    saveTailRef.current = saveTailRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await store.save(next);
        if (currentRef.current === next) {
          currentRef.current = saved;
          setPreferences(saved);
        }
      })
      .catch(() => {
        if (currentRef.current === next) setError("无法保存偏好设置");
      })
      .finally(() => {
        if (currentRef.current === next) setSaving(false);
      });
  }, [store]);

  return { preferences, loading, saving, error, update, store };
}
