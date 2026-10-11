import { useEffect } from 'react';
import * as accountsApi from '../api/accounts';
import { useAuth } from '../context/AuthContext';

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // server only records once a minute; 'online' lasts 5 min

export function usePresenceHeartbeat() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return undefined;
    accountsApi.sendPresencePing().catch(() => {});
    const interval = setInterval(() => accountsApi.sendPresencePing().catch(() => {}), HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user]);
}