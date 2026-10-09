import { useEffect, useRef, useState } from 'react';
import * as servicesApi from '../api/services';

const DEBOUNCE_MS = 400;

export function useServiceSearch({ q, categoryId, area }) {
  const [status, setStatus] = useState('loading'); // 'loading' | 'error' | 'success'
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);
  const isFirstRun = useRef(true);

  useEffect(() => {
    const runFetch = () => {
      servicesApi
        .listServices({
          q: q || undefined,
          category_id: categoryId || undefined,
          area: area || undefined,
        })
        .then((data) => {
          setResults(data.results);
          setStatus('success');
        })
        .catch((err) => {
          setError(err);
          setStatus('error');
        });
    };

    setStatus('loading');
    setError(null);
    clearTimeout(debounceRef.current);

    // Skip the debounce on mount and on dropdown changes -- only
    // typing into the free-text `q` field should feel delayed.
    if (isFirstRun.current) {
      isFirstRun.current = false;
      runFetch();
    } else {
      debounceRef.current = setTimeout(runFetch, DEBOUNCE_MS);
    }

    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, categoryId, area]);

  return { status, results, error };
}