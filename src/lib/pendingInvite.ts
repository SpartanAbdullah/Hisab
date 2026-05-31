const PENDING_INVITE_KEY = 'hisaab_pending_invite';

export function savePendingInvite(token: string): void {
  if (token) localStorage.setItem(PENDING_INVITE_KEY, token);
}

export function getPendingInvite(): string | null {
  return localStorage.getItem(PENDING_INVITE_KEY);
}

export function clearPendingInvite(token?: string): void {
  if (!token || getPendingInvite() === token) {
    localStorage.removeItem(PENDING_INVITE_KEY);
  }
}

export function getPendingInviteResumePath(options: {
  completed: boolean;
  currentPath: string;
  hasUser: boolean;
}): string | null {
  if (!options.hasUser || !options.completed) return null;
  const pendingInvite = getPendingInvite();
  if (!pendingInvite) return null;
  const invitePath = `/join/${pendingInvite}`;
  return options.currentPath === invitePath ? null : invitePath;
}
