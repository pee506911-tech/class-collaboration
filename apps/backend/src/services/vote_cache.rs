use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Time-to-live for cached vote results. 500ms is imperceptible on a vote
/// counter but eliminates the vast majority of redundant DB queries during
/// vote storms (150+ students voting within a few seconds).
const VOTE_CACHE_TTL: Duration = Duration::from_millis(500);

/// In-memory cache for aggregated vote results keyed by slide ID.
///
/// During a vote storm, multiple votes for the same slide trigger
/// `broadcast_vote_update` calls that each read from `vote_count_shards`.
/// This cache coalesces those reads: the first vote hits the DB, subsequent
/// votes within 500ms reuse the cached aggregation.
pub struct VoteResultCache {
    entries: Mutex<HashMap<String, VoteEntry>>,
}

struct VoteEntry {
    results: Value,
    cached_at: Instant,
}

impl VoteResultCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Get cached vote results for a slide if still fresh (within TTL).
    pub fn get(&self, slide_id: &str) -> Option<Value> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(slide_id)?;
        if entry.cached_at.elapsed() < VOTE_CACHE_TTL {
            Some(entry.results.clone())
        } else {
            // Stale — will be replaced on next insert
            None
        }
    }

    /// Store vote results in the cache with the current timestamp.
    pub fn insert(&self, slide_id: &str, results: Value) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                slide_id.to_string(),
                VoteEntry {
                    results,
                    cached_at: Instant::now(),
                },
            );
        }
    }

    /// Remove cache entries for a specific slide (e.g., when slide is deleted).
    pub fn invalidate_slide(&self, slide_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(slide_id);
        }
    }

    /// Clear all cached entries (e.g., when session ends).
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }

    /// Remove entries that are older than TTL (housekeeping).
    pub fn prune_expired(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, entry| entry.cached_at.elapsed() < VOTE_CACHE_TTL);
        }
    }
}

impl Default for VoteResultCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn cache_returns_entry_within_ttl() {
        let cache = VoteResultCache::new();
        let results = serde_json::json!({ "opt-a": 3, "opt-b": 7 });
        cache.insert("slide-1", results.clone());

        let cached = cache.get("slide-1");
        assert_eq!(cached, Some(results));
    }

    #[test]
    fn cache_returns_none_after_ttl() {
        let cache = VoteResultCache::new();
        let results = serde_json::json!({ "opt-a": 1 });
        cache.insert("slide-1", results);

        // Wait for TTL to expire
        thread::sleep(VOTE_CACHE_TTL + Duration::from_millis(50));

        let cached = cache.get("slide-1");
        assert!(cached.is_none());
    }

    #[test]
    fn cache_overwrites_with_latest_value() {
        let cache = VoteResultCache::new();
        cache.insert("slide-1", serde_json::json!({ "opt-a": 1 }));
        cache.insert("slide-1", serde_json::json!({ "opt-a": 5 }));

        let cached = cache.get("slide-1").unwrap();
        assert_eq!(cached["opt-a"], 5);
    }

    #[test]
    fn invalidate_slide_removes_entry() {
        let cache = VoteResultCache::new();
        cache.insert("slide-1", serde_json::json!({ "opt-a": 1 }));
        cache.invalidate_slide("slide-1");

        assert!(cache.get("slide-1").is_none());
    }

    #[test]
    fn clear_removes_all_entries() {
        let cache = VoteResultCache::new();
        cache.insert("slide-1", serde_json::json!({ "opt-a": 1 }));
        cache.insert("slide-2", serde_json::json!({ "opt-b": 2 }));
        cache.clear();

        assert!(cache.get("slide-1").is_none());
        assert!(cache.get("slide-2").is_none());
    }

    #[test]
    fn prune_expired_removes_stale_entries() {
        let cache = VoteResultCache::new();
        cache.insert("slide-1", serde_json::json!({ "opt-a": 1 }));
        cache.insert("slide-2", serde_json::json!({ "opt-b": 2 }));

        // Wait for TTL to expire
        thread::sleep(VOTE_CACHE_TTL + Duration::from_millis(50));

        // Add a fresh entry that should survive pruning
        cache.insert("slide-3", serde_json::json!({ "opt-c": 3 }));

        cache.prune_expired();

        assert!(cache.get("slide-1").is_none());
        assert!(cache.get("slide-2").is_none());
        assert!(cache.get("slide-3").is_some());
    }

    #[test]
    fn cache_is_send_sync() {
        fn assert_send<T: Send + Sync>() {}
        assert_send::<VoteResultCache>();
    }
}
