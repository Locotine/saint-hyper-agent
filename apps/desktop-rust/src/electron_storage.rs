// FILE: electron_storage.rs
// Purpose: One-time import of Electron Chromium Local Storage (`saint://app` origin)
//          into `~/.saint/userdata/saint-storage-origin-v1.json` for Tauri startup migration.
// Layer: Desktop state persistence & storage migration.

use rusty_leveldb::{LdbIterator, Options, DB};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::state::SaintPaths;
use crate::window_state::{
    is_saint_storage_key, SaintStorageSnapshot, SAINT_STORAGE_SNAPSHOT_MAX_BYTES,
    SAINT_STORAGE_SNAPSHOT_MAX_ENTRIES, SAINT_STORAGE_SNAPSHOT_MAX_KEY_LENGTH,
};

pub const ELECTRON_STORAGE_IMPORT_MARKER_FILE: &str = "electron-storage-import-v1.done";
pub const ELECTRON_STORAGE_IMPORT_ATTEMPTS_FILE: &str = "electron-storage-import-v1.attempts";
pub const ELECTRON_STORAGE_MAX_IMPORT_ATTEMPTS: u32 = 3;
const CHROMIUM_SAINT_ORIGIN_KEY_PREFIX: &[u8] = b"_saint://app\x00";
const SNAPSHOT_ENVELOPE_OVERHEAD_BYTES: usize = 128;
const SNAPSHOT_ENTRY_OVERHEAD_BYTES: usize = 6; // `"":"",`

pub fn json_escaped_string_content_len(s: &str) -> usize {
    let mut extra: usize = 0;
    for &b in s.as_bytes() {
        match b {
            b'"' | b'\\' | b'\x08' | b'\x0c' | b'\n' | b'\r' | b'\t' => {
                extra = extra.saturating_add(1);
            }
            0x00..=0x1f => {
                extra = extra.saturating_add(5);
            }
            _ => {}
        }
    }
    s.len().saturating_add(extra)
}

pub fn json_serialized_entry_len(key: &str, value: &str) -> usize {
    json_escaped_string_content_len(key)
        .saturating_add(json_escaped_string_content_len(value))
        .saturating_add(SNAPSHOT_ENTRY_OVERHEAD_BYTES)
}

pub fn decode_chromium_storage_string(bytes: &[u8]) -> Option<String> {
    let (&format_byte, payload) = bytes.split_first()?;
    match format_byte {
        0 => {
            if payload.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = payload
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect();
            String::from_utf16(&units).ok()
        }
        1 => Some(payload.iter().map(|&b| char::from(b)).collect()),
        _ => None,
    }
}

pub fn default_electron_leveldb_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("saint").join("Local Storage").join("leveldb"))
}

/// Resolves the Tauri WebView profile directory for `com.locotine.saint` where the platform
/// location is deterministic:
/// - Windows (WebView2): `%LOCALAPPDATA%\com.locotine.saint\EBWebView`
/// - macOS (WKWebView): `~/Library/WebKit/com.locotine.saint`
/// - Linux (WebKitGTK): omitted (`None`) because WebKitGTK data paths vary across versions/XDG
///   layouts and share the parent `<data_local_dir>/com.locotine.saint` directory.
pub fn default_tauri_webview_profile_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|dir| dir.join(crate::state::APP_BUNDLE_ID).join("EBWebView"))
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|home| home.join("Library").join("WebKit").join(crate::state::APP_BUNDLE_ID))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

pub fn read_electron_leveldb_entries(leveldb_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let temp_dir = std::env::temp_dir().join(format!(
        "saint-electron-leveldb-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temporary LevelDB directory: {e}"))?;

    let result = (|| -> Result<BTreeMap<String, String>, String> {
        let dir_entries = std::fs::read_dir(leveldb_dir)
            .map_err(|e| format!("Failed to read Electron LevelDB directory: {e}"))?;

        for entry_res in dir_entries {
            let entry =
                entry_res.map_err(|e| format!("Failed to inspect LevelDB directory entry: {e}"))?;
            let file_name = entry.file_name();
            if file_name.to_string_lossy().eq_ignore_ascii_case("LOCK") {
                continue;
            }
            let src_path = entry.path();
            let is_regular_file = entry
                .file_type()
                .map(|ft| ft.is_file() && !ft.is_symlink())
                .unwrap_or(false);
            if is_regular_file {
                let dst_path = temp_dir.join(&file_name);
                std::fs::copy(&src_path, &dst_path).map_err(|e| {
                    format!(
                        "Failed to copy LevelDB file '{}': {e}",
                        src_path.display()
                    )
                })?;
            }
        }

        let mut opts = Options::default();
        opts.create_if_missing = false;
        let mut db = DB::open(&temp_dir, opts)
            .map_err(|e| format!("Failed to open copied Electron LevelDB: {e}"))?;
        let mut iter = db
            .new_iter()
            .map_err(|e| format!("Failed to iterate Electron LevelDB: {e}"))?;

        let mut entries = BTreeMap::<String, String>::new();
        let mut serialized_bytes_used: usize = SNAPSHOT_ENVELOPE_OVERHEAD_BYTES;

        while let Some((raw_key, raw_value)) = iter.next() {
            let Some(encoded_key) = raw_key.strip_prefix(CHROMIUM_SAINT_ORIGIN_KEY_PREFIX) else {
                continue;
            };
            let Some(key) = decode_chromium_storage_string(encoded_key) else {
                continue;
            };
            if key.is_empty()
                || key.len() > SAINT_STORAGE_SNAPSHOT_MAX_KEY_LENGTH
                || !is_saint_storage_key(&key)
            {
                continue;
            }
            let Some(value) = decode_chromium_storage_string(&raw_value) else {
                continue;
            };
            if value.len() > SAINT_STORAGE_SNAPSHOT_MAX_BYTES {
                continue;
            }
            if !entries.contains_key(&key) && entries.len() >= SAINT_STORAGE_SNAPSHOT_MAX_ENTRIES {
                continue;
            }

            let entry_serialized_len = json_serialized_entry_len(&key, &value);
            let prior_len = entries
                .get(&key)
                .map(|prev_val| json_serialized_entry_len(&key, prev_val))
                .unwrap_or(0);
            let next_total = serialized_bytes_used
                .saturating_sub(prior_len)
                .saturating_add(entry_serialized_len);
            if next_total > SAINT_STORAGE_SNAPSHOT_MAX_BYTES {
                continue;
            }

            serialized_bytes_used = next_total;
            entries.insert(key, value);
        }

        Ok(entries)
    })();

    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

fn write_import_marker(marker_path: &Path) {
    if let Some(parent) = marker_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(marker_path, b"1\n");
}

fn record_failed_import_attempt(state_dir: &Path, marker_path: &Path) {
    let attempts_path = state_dir.join(ELECTRON_STORAGE_IMPORT_ATTEMPTS_FILE);
    let prev_attempts = std::fs::read_to_string(&attempts_path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let attempts = prev_attempts.saturating_add(1);
    if let Some(parent) = attempts_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&attempts_path, format!("{attempts}\n"));
    if attempts >= ELECTRON_STORAGE_MAX_IMPORT_ATTEMPTS {
        eprintln!(
            "[saint-desktop-rust] Electron localStorage import failed {attempts} times; writing done marker and stopping retries"
        );
        write_import_marker(marker_path);
    }
}

pub fn import_electron_local_storage_from_dir(
    paths: &SaintPaths,
    source_leveldb_dir: Option<&Path>,
    explicit_saint_home: Option<&str>,
    existing_webview_profile_dir: Option<&Path>,
) {
    if paths.is_isolated_dev_instance
        || explicit_saint_home.is_some_and(|val| !val.trim().is_empty())
    {
        return;
    }
    if paths.storage_snapshot_path.exists() {
        return;
    }
    let marker_path = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_MARKER_FILE);
    if marker_path.exists() {
        return;
    }
    if existing_webview_profile_dir.is_some_and(|dir| dir.is_dir()) {
        write_import_marker(&marker_path);
        return;
    }

    let Some(leveldb_dir) = source_leveldb_dir else {
        write_import_marker(&marker_path);
        return;
    };
    if !leveldb_dir.is_dir() {
        write_import_marker(&marker_path);
        return;
    }

    match read_electron_leveldb_entries(leveldb_dir) {
        Ok(entries) => {
            if !entries.is_empty() {
                let exported_at = OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
                let snapshot = SaintStorageSnapshot {
                    version: 1,
                    exported_at,
                    entries,
                };
                let serialized = match serde_json::to_string(&snapshot) {
                    Ok(serialized) => serialized,
                    Err(err) => {
                        eprintln!(
                            "[saint-desktop-rust] Failed to serialize Electron storage snapshot: {err}"
                        );
                        record_failed_import_attempt(&paths.state_dir, &marker_path);
                        return;
                    }
                };
                if let Some(parent) = paths.storage_snapshot_path.parent() {
                    if let Err(err) = std::fs::create_dir_all(parent) {
                        eprintln!(
                            "[saint-desktop-rust] Failed to create snapshot parent dir: {err}"
                        );
                        record_failed_import_attempt(&paths.state_dir, &marker_path);
                        return;
                    }
                }
                let tmp_path = paths.storage_snapshot_path.with_extension("json.tmp");
                if let Err(err) = std::fs::write(&tmp_path, format!("{serialized}\n")) {
                    let _ = std::fs::remove_file(&tmp_path);
                    eprintln!(
                        "[saint-desktop-rust] Failed to write temporary Electron storage snapshot: {err}"
                    );
                    record_failed_import_attempt(&paths.state_dir, &marker_path);
                    return;
                }
                if let Err(err) = std::fs::rename(&tmp_path, &paths.storage_snapshot_path) {
                    let _ = std::fs::remove_file(&tmp_path);
                    eprintln!(
                        "[saint-desktop-rust] Failed to commit Electron storage snapshot: {err}"
                    );
                    record_failed_import_attempt(&paths.state_dir, &marker_path);
                    return;
                }
            }
            write_import_marker(&marker_path);
        }
        Err(err) => {
            eprintln!("[saint-desktop-rust] Failed to import Electron localStorage: {err}");
            record_failed_import_attempt(&paths.state_dir, &marker_path);
        }
    }
}

pub fn import_electron_local_storage(paths: &SaintPaths) {
    let explicit_saint_home = std::env::var("SAINT_HOME").ok();
    let source_dir = default_electron_leveldb_dir();
    let webview_profile_dir = default_tauri_webview_profile_dir();
    import_electron_local_storage_from_dir(
        paths,
        source_dir.as_deref(),
        explicit_saint_home.as_deref(),
        webview_profile_dir.as_deref(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_state::read_saint_storage_snapshot;

    fn encode_latin1(s: &str) -> Vec<u8> {
        let mut out = vec![1u8];
        out.extend_from_slice(s.as_bytes());
        out
    }

    fn encode_utf16le(s: &str) -> Vec<u8> {
        let mut out = vec![0u8];
        for unit in s.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    fn make_chromium_key(origin: &str, encoded_key: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(b'_');
        out.extend_from_slice(origin.as_bytes());
        out.push(0u8);
        out.extend_from_slice(encoded_key);
        out
    }

    #[test]
    fn imports_only_saint_keys_from_chromium_leveldb_in_utf16_and_latin1() {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-storage-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let leveldb_dir = root.join("electron-leveldb");
        let saint_home = root.join("saint-home");
        std::fs::create_dir_all(&leveldb_dir).unwrap();

        {
            let mut db = DB::open(&leveldb_dir, Options::default()).unwrap();
            // 1. saint: key with Latin-1 key & UTF-16LE value
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("saint:settings")),
                &encode_utf16le("{\"theme\":\"dark\",\" emoji\":\"🚀\"}"),
            )
            .unwrap();
            // 2. saint. key with UTF-16LE key & Latin-1 value
            db.put(
                &make_chromium_key("saint://app", &encode_utf16le("saint.onboarding.v1")),
                &encode_latin1("completed"),
            )
            .unwrap();
            // 3. Non-saint key on saint://app
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("other:key")),
                &encode_latin1("ignored"),
            )
            .unwrap();
            // 4. Another origin with saint: key
            db.put(
                &make_chromium_key("https://example.com", &encode_latin1("saint:leaked")),
                &encode_latin1("ignored"),
            )
            .unwrap();
            // 5. META / VERSION keys
            db.put(b"VERSION", b"1").unwrap();
            db.put(b"META:saint://app", b"\x01\x02").unwrap();
            db.put(b"METAACCESS:saint://app", b"\x01\x02").unwrap();
            db.flush().unwrap();
        }
        // Simulate Electron holding LOCK file
        std::fs::write(leveldb_dir.join("LOCK"), b"locked").unwrap();

        let paths = SaintPaths::from_base_dir(saint_home);
        paths.ensure_directories().unwrap();

        import_electron_local_storage_from_dir(&paths, Some(&leveldb_dir), None, None);

        let marker = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_MARKER_FILE);
        assert!(marker.is_file(), "marker file must be written");

        let snapshot = read_saint_storage_snapshot(&paths.storage_snapshot_path)
            .expect("snapshot must be readable and valid");
        assert_eq!(snapshot.version, 1);
        assert_eq!(snapshot.entries.len(), 2);
        assert_eq!(
            snapshot.entries.get("saint:settings").map(String::as_str),
            Some("{\"theme\":\"dark\",\" emoji\":\"🚀\"}")
        );
        assert_eq!(
            snapshot
                .entries
                .get("saint.onboarding.v1")
                .map(String::as_str),
            Some("completed")
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_import_when_marker_already_exists() {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-marker-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let leveldb_dir = root.join("electron-leveldb");
        let saint_home = root.join("saint-home");
        std::fs::create_dir_all(&leveldb_dir).unwrap();

        {
            let mut db = DB::open(&leveldb_dir, Options::default()).unwrap();
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("saint:settings")),
                &encode_latin1("{\"theme\":\"dark\"}"),
            )
            .unwrap();
            db.flush().unwrap();
        }

        let paths = SaintPaths::from_base_dir(saint_home);
        paths.ensure_directories().unwrap();
        let marker = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_MARKER_FILE);
        std::fs::write(&marker, b"1\n").unwrap();

        import_electron_local_storage_from_dir(&paths, Some(&leveldb_dir), None, None);

        assert!(
            !paths.storage_snapshot_path.exists(),
            "snapshot must not be created when marker already exists"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_import_and_writes_marker_when_tauri_webview_profile_already_exists() {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-webview-profile-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let leveldb_dir = root.join("electron-leveldb");
        let existing_webview_dir = root.join("EBWebView");
        let saint_home = root.join("saint-home");
        std::fs::create_dir_all(&leveldb_dir).unwrap();
        std::fs::create_dir_all(&existing_webview_dir).unwrap();

        {
            let mut db = DB::open(&leveldb_dir, Options::default()).unwrap();
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("saint:settings")),
                &encode_latin1("{\"theme\":\"dark\"}"),
            )
            .unwrap();
            db.flush().unwrap();
        }

        let paths = SaintPaths::from_base_dir(saint_home);
        paths.ensure_directories().unwrap();
        let marker = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_MARKER_FILE);

        import_electron_local_storage_from_dir(
            &paths,
            Some(&leveldb_dir),
            None,
            Some(&existing_webview_dir),
        );

        assert!(
            !paths.storage_snapshot_path.exists(),
            "snapshot must not be created when Tauri WebView profile already exists"
        );
        assert!(
            marker.is_file(),
            "done marker must be written when skipping due to existing Tauri WebView profile"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn writes_done_marker_after_three_failed_import_attempts_and_skips_fourth() {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-corrupt-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let corrupt_leveldb_dir = root.join("corrupt-leveldb");
        let valid_leveldb_dir = root.join("valid-leveldb");
        let saint_home = root.join("saint-home");
        std::fs::create_dir_all(&corrupt_leveldb_dir).unwrap();
        std::fs::write(corrupt_leveldb_dir.join("CURRENT"), b"INVALID-MANIFEST\n").unwrap();

        {
            std::fs::create_dir_all(&valid_leveldb_dir).unwrap();
            let mut db = DB::open(&valid_leveldb_dir, Options::default()).unwrap();
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("saint:settings")),
                &encode_latin1("{\"theme\":\"dark\"}"),
            )
            .unwrap();
            db.flush().unwrap();
        }

        let paths = SaintPaths::from_base_dir(saint_home);
        paths.ensure_directories().unwrap();
        let marker = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_MARKER_FILE);
        let attempts_file = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_ATTEMPTS_FILE);

        // Attempts 1 and 2 fail without writing the done marker.
        for expected_attempt in 1..=2 {
            import_electron_local_storage_from_dir(&paths, Some(&corrupt_leveldb_dir), None, None);
            assert!(!paths.storage_snapshot_path.exists());
            assert!(!marker.exists());
            assert_eq!(
                std::fs::read_to_string(&attempts_file).unwrap().trim(),
                expected_attempt.to_string()
            );
        }

        // Attempt 3 fails and writes the done marker so subsequent launches stop retrying.
        import_electron_local_storage_from_dir(&paths, Some(&corrupt_leveldb_dir), None, None);
        assert!(!paths.storage_snapshot_path.exists());
        assert_eq!(std::fs::read_to_string(&attempts_file).unwrap().trim(), "3");
        assert!(
            marker.is_file(),
            "done marker must be written after 3 failed attempts"
        );

        // 4th call with a valid LevelDB does not attempt import because the done marker is set.
        import_electron_local_storage_from_dir(&paths, Some(&valid_leveldb_dir), None, None);
        assert!(
            !paths.storage_snapshot_path.exists(),
            "fourth call must not attempt import after done marker is written"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_import_when_explicit_saint_home_is_set() {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-explicit-home-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let leveldb_dir = root.join("electron-leveldb");
        let saint_home = root.join("saint-home");
        std::fs::create_dir_all(&leveldb_dir).unwrap();

        {
            let mut db = DB::open(&leveldb_dir, Options::default()).unwrap();
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("saint:settings")),
                &encode_latin1("{\"theme\":\"dark\"}"),
            )
            .unwrap();
            db.flush().unwrap();
        }

        let paths = SaintPaths::from_base_dir(saint_home.clone());
        paths.ensure_directories().unwrap();
        let marker = paths.state_dir.join(ELECTRON_STORAGE_IMPORT_MARKER_FILE);

        import_electron_local_storage_from_dir(
            &paths,
            Some(&leveldb_dir),
            Some(&saint_home.to_string_lossy()),
            None,
        );

        assert!(
            !paths.storage_snapshot_path.exists(),
            "explicit SAINT_HOME must not import production Electron storage"
        );
        assert!(
            !marker.exists(),
            "explicit SAINT_HOME must not write import marker"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn escaped_values_full_of_quotes_and_backslashes_near_limit_stay_under_16_mib_after_serialization()
    {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-escape-budget-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let leveldb_dir = root.join("electron-leveldb");
        let saint_home = root.join("saint-home");
        std::fs::create_dir_all(&leveldb_dir).unwrap();

        // Each 2-byte pattern `\"` is 2 raw bytes and 4 JSON-escaped bytes (`\\\"`).
        // Three entries of 2.6 MiB raw each -> 5.2 MiB serialized each:
        // 2 entries fit (~10.4 MiB serialized <= 16 MiB), 3rd entry would push total to ~15.6 MiB
        // (fits), and a 4th entry would push serialized size past 16 MiB even though 4 * 2.6 MiB =
        // 10.4 MiB raw is well below 90% of 16 MiB (14.4 MiB).
        let chunk_raw = "\"\\".repeat(1_363_148); // ~2.6 MiB raw, ~5.2 MiB JSON-escaped
        assert_eq!(
            json_escaped_string_content_len(&chunk_raw) + 2,
            serde_json::to_string(&chunk_raw).unwrap().len()
        );
        let control_sample = "a\"\\\n\r\t\x08\x0c\x00\x1f";
        assert_eq!(
            json_escaped_string_content_len(control_sample) + 2,
            serde_json::to_string(control_sample).unwrap().len()
        );

        {
            let mut db = DB::open(&leveldb_dir, Options::default()).unwrap();
            for idx in 0..4 {
                let key = format!("saint:escaped-{idx}");
                db.put(
                    &make_chromium_key("saint://app", &encode_latin1(&key)),
                    &encode_latin1(&chunk_raw),
                )
                .unwrap();
            }
            db.flush().unwrap();
        }

        let paths = SaintPaths::from_base_dir(saint_home);
        paths.ensure_directories().unwrap();
        import_electron_local_storage_from_dir(&paths, Some(&leveldb_dir), None, None);

        let raw_file = std::fs::read_to_string(&paths.storage_snapshot_path).unwrap();
        assert!(
            raw_file.len() <= SAINT_STORAGE_SNAPSHOT_MAX_BYTES,
            "serialized snapshot file ({} bytes) must stay <= 16 MiB ({})",
            raw_file.len(),
            SAINT_STORAGE_SNAPSHOT_MAX_BYTES
        );
        let snapshot = read_saint_storage_snapshot(&paths.storage_snapshot_path)
            .expect("snapshot must pass read_saint_storage_snapshot 16 MiB check");
        assert_eq!(snapshot.entries.len(), 3);
        let reserialized = serde_json::to_string(&snapshot).unwrap();
        assert!(reserialized.len() <= SAINT_STORAGE_SNAPSHOT_MAX_BYTES);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinks_when_copying_leveldb_directory_entries() {
        let root = std::env::temp_dir().join(format!(
            "saint-electron-symlink-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let leveldb_dir = root.join("electron-leveldb");
        std::fs::create_dir_all(&leveldb_dir).unwrap();

        {
            let mut db = DB::open(&leveldb_dir, Options::default()).unwrap();
            db.put(
                &make_chromium_key("saint://app", &encode_latin1("saint:ok")),
                &encode_latin1("1"),
            )
            .unwrap();
            db.flush().unwrap();
        }

        // Add a dangling or external symlink inside leveldb_dir; it must be ignored rather than copied.
        let symlink_path = leveldb_dir.join("999999.ldb");
        std::os::unix::fs::symlink("/nonexistent/outside-target", &symlink_path).unwrap();

        let entries = read_electron_leveldb_entries(&leveldb_dir).unwrap();
        assert_eq!(entries.get("saint:ok").map(String::as_str), Some("1"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore]
    fn inspect_local_appdata_electron_leveldb_keys_only() {
        let Some(leveldb_dir) = default_electron_leveldb_dir() else {
            println!("No config_dir found");
            return;
        };
        println!("Inspecting Electron LevelDB at: {}", leveldb_dir.display());
        let entries = read_electron_leveldb_entries(&leveldb_dir)
            .expect("should read real Electron LevelDB copy");
        println!("REAL_ELECTRON_KEY_COUNT={}", entries.len());
        for key in entries.keys() {
            println!("REAL_ELECTRON_KEY={key}");
        }
    }
}
