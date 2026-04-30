import { useEffect, useState } from 'react';
import {
  getServiceHealthSnapshot,
  ServiceHealthSnapshot,
  subscribeServiceHealth,
} from '../../Network/serviceHealth';

export function useServiceHealth(): ServiceHealthSnapshot {
  const [snapshot, setSnapshot] = useState<ServiceHealthSnapshot>(() => getServiceHealthSnapshot());

  useEffect(() => subscribeServiceHealth(setSnapshot), []);

  return snapshot;
}
