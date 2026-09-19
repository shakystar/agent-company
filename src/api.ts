import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '../shared/types';

export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `요청을 처리하지 못했습니다 (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current;
    try {
      const next = await request<Workspace>('/workspace', 'GET', undefined, signal);
      if (mounted.current && current === sequence.current) { setWorkspace(next); setError(''); }
    } catch (failure) {
      if (mounted.current && current === sequence.current && !signal?.aborted) {
        setError(failure instanceof Error ? failure.message : '서버에 연결하지 못했습니다.');
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === 'visible') await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    };
    void poll();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  return { workspace, error, refresh };
}

export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const execute = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setPending(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '변경을 저장하지 못했습니다.'); }
    finally { lock.current = false; setPending(false); }
  };
  return { pending, error, execute };
}
