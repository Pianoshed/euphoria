import { useCallback, useSyncExternalStore } from 'react';
import { getDataSaverSetting, isDataSaverOn, setDataSaverSetting, subscribeDataSaver } from '../utils/dataSaver';

/** { setting: 'auto'|'on'|'off', active: boolean, setSetting } and re-renders when it changes. */
export function useDataSaver() {
  const setting = useSyncExternalStore(subscribeDataSaver, getDataSaverSetting, () => 'auto');
  const active = useSyncExternalStore(subscribeDataSaver, isDataSaverOn, () => false);
  const setSetting = useCallback((v) => setDataSaverSetting(v), []);
  return { setting, active, setSetting };
}
