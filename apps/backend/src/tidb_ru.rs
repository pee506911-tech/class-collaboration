use once_cell::sync::Lazy;
use rand::Rng;
use serde_json::Value;
use sqlx::MySql;
use std::sync::atomic::{AtomicBool, Ordering};

struct TidbRuSampler {
    enabled: bool,
    sample_rate: f64,
    supported: AtomicBool,
    warned_unsupported: AtomicBool,
}

impl TidbRuSampler {
    fn from_env() -> Self {
        let enabled = std::env::var("TIDB_RU_SAMPLING_ENABLED")
            .ok()
            .as_deref()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let sample_rate = std::env::var("TIDB_RU_SAMPLE_RATE")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);

        Self {
            enabled,
            sample_rate,
            supported: AtomicBool::new(true),
            warned_unsupported: AtomicBool::new(false),
        }
    }

    fn should_sample(&self) -> bool {
        if !self.enabled || self.sample_rate <= 0.0 {
            return false;
        }
        if !self.supported.load(Ordering::Relaxed) {
            return false;
        }
        let mut rng = rand::thread_rng();
        rng.gen::<f64>() < self.sample_rate
    }

    fn disable_sampling(&self) {
        self.supported.store(false, Ordering::Relaxed);
    }
}

static SAMPLER: Lazy<TidbRuSampler> = Lazy::new(TidbRuSampler::from_env);

pub fn should_sample() -> bool {
    SAMPLER.should_sample()
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn get_path_f64(v: &Value, path: &[&str]) -> Option<f64> {
    let mut cur = v;
    for key in path {
        cur = cur.get(*key)?;
    }
    as_f64(cur)
}

fn get_any_ru(v: &Value) -> Option<f64> {
    get_path_f64(v, &["ru_consumption"])
        .or_else(|| get_path_f64(v, &["ru"]))
        .or_else(|| get_path_f64(v, &["RU"]))
        .or_else(|| get_path_f64(v, &["resource_unit"]))
}

fn get_any_scan_keys(v: &Value) -> Option<f64> {
    get_path_f64(v, &["scan_keys"])
        .or_else(|| get_path_f64(v, &["scanKey"]))
        .or_else(|| get_path_f64(v, &["scan_keys_total"]))
}

fn get_any_scan_rows(v: &Value) -> Option<f64> {
    get_path_f64(v, &["scan_rows"])
        .or_else(|| get_path_f64(v, &["scanRows"]))
        .or_else(|| get_path_f64(v, &["scan_rows_total"]))
}

/// Query TiDB's `@@tidb_last_query_info` on the *same* connection that ran the
/// previous statement and log best-effort RU/scan info.
///
/// This is opt-in via env vars and self-disables if unsupported (e.g. MySQL).
pub async fn log_last_query_info<'e, E>(label: &'static str, executor: E)
where
    E: sqlx::Executor<'e, Database = MySql>,
{
    if !SAMPLER.enabled || SAMPLER.sample_rate <= 0.0 {
        return;
    }
    if !SAMPLER.supported.load(Ordering::Relaxed) {
        return;
    }

    let raw: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("SELECT @@tidb_last_query_info")
            .fetch_optional(executor)
            .await;

    let raw = match raw {
        Ok(v) => v.unwrap_or_default(),
        Err(e) => {
            SAMPLER.disable_sampling();
            if !SAMPLER.warned_unsupported.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    error = %e,
                    "TiDB RU sampling disabled: @@tidb_last_query_info unsupported or inaccessible"
                );
            }
            return;
        }
    };

    let parsed: Option<Value> = serde_json::from_str(&raw).ok();
    if let Some(info) = parsed {
        tracing::info!(
            tidb_ru_label = label,
            tidb_ru = get_any_ru(&info),
            tidb_scan_keys = get_any_scan_keys(&info),
            tidb_scan_rows = get_any_scan_rows(&info),
            "tidb_last_query_info"
        );
    } else {
        tracing::info!(tidb_ru_label = label, tidb_last_query_info = %raw, "tidb_last_query_info");
    }
}
