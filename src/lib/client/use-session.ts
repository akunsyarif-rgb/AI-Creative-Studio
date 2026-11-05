"use client";

import { useEffect, useMemo, useState } from "react";
import { createApiClient } from "./api";
import { authConfigured, currentUser, getJwt, type SessionUser } from "./auth";

export function useApi() {
  return useMemo(() => createApiClient(getJwt), []);
}

/** `undefined` = still checking, `null` = signed out. */
export function useSessionUser(): SessionUser | null | undefined {
  const [user, setUser] = useState<SessionUser | null | undefined>(authConfigured ? undefined : null);
  useEffect(() => {
    if (!authConfigured) return;
    let live = true;
    currentUser().then((u) => live && setUser(u));
    return () => {
      live = false;
    };
  }, []);
  return user;
}
