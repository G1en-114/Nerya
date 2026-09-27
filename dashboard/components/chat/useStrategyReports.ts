"use client";
import { useEffect, useState } from 'react';
import { clientApi, type BacktestRunSummary } from '../../lib/clientApi';
export function useStrategyReports(strategyId: string, revision: number, proposalId?: string | null) {
  const identity = JSON.stringify([strategyId, proposalId || '']);
  const [state, setState] = useState<{ strategy: string; runs: BacktestRunSummary[]; error: string }>({ strategy: '', runs: [], error: '' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!strategyId) return;
    let alive = true;
    async function load() {
      try {
        const data = await clientApi.strategyBacktests(strategyId, proposalId);
        if (data.ok === false) throw new Error('Unable to load backtest reports');
        if (alive) setState({ strategy: identity, runs: data.backtests || [], error: '' });
      } catch (reason) { if (alive) setState(old => ({ strategy: identity, runs: old.strategy === identity ? old.runs : [], error: String(reason) })); }
    }
    void load(); window.addEventListener('focus', load);
    return () => { alive = false; window.removeEventListener('focus', load); };
  }, [strategyId, proposalId, identity, revision, retry]);
  return { runs: state.strategy === identity ? state.runs : [], error: state.strategy === identity ? state.error : '', retry: () => setRetry(n => n + 1) };
}
