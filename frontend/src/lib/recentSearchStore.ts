/**
 * Persists the last N spotlight queries in localStorage so the dock can show
 * "Recent" suggestions when the input is empty.
 */

import { createSignal } from "solid-js";

const STORAGE_KEY = "raum:spotlight:recent";
const MAX = 10;

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function save(items: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore quota errors.
  }
}

const [recentSearches, setRecentSearches] = createSignal<string[]>(load());

export { recentSearches };

export function addRecentSearch(query: string): void {
  const q = query.trim();
  if (!q) return;
  setRecentSearches((prev) => {
    const deduped = [q, ...prev.filter((r) => r !== q)].slice(0, MAX);
    save(deduped);
    return deduped;
  });
}

export function clearRecentSearch(query: string): void {
  setRecentSearches((prev) => {
    const next = prev.filter((r) => r !== query);
    save(next);
    return next;
  });
}
