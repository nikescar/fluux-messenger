use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateInput {
    pub payload: serde_json::Value,
    pub info: Option<String>,
    pub document: Option<String>,
    pub summary: Option<String>,
    pub sender: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedUpdate {
    pub serial: i64,
    pub max_serial: i64,
    pub payload: serde_json::Value,
    pub info: Option<String>,
    pub document: Option<String>,
    pub summary: Option<String>,
    pub sender: String,
    pub timestamp: i64,
}

pub type WebxdcUpdate = SavedUpdate;

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct InstanceMetadata {
    pub extract_path: String,
    pub manifest: serde_json::Value,
    pub last_opened: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug)]
pub struct StaleInstance {
    pub instance_id: String,
    pub extract_path: String,
}

pub struct WebxdcStorage {
    pool: Arc<Mutex<Connection>>,
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS webxdc_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    serial INTEGER NOT NULL,
    max_serial INTEGER NOT NULL,
    payload TEXT NOT NULL,
    info TEXT,
    document TEXT,
    summary TEXT,
    sender_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(instance_id, serial)
);

CREATE INDEX IF NOT EXISTS idx_instance_serial ON webxdc_updates(instance_id, serial);

CREATE TABLE IF NOT EXISTS webxdc_metadata (
    instance_id TEXT PRIMARY KEY,
    extract_path TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    last_opened INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webxdc_threads (
    instance_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL
);
"#;

impl WebxdcStorage {
    pub fn new(data_dir: PathBuf) -> Result<Self, rusqlite::Error> {
        let db_path = data_dir.join("webxdc.db");
        let conn = Connection::open(db_path)?;

        conn.execute_batch(SCHEMA_SQL)?;

        Ok(Self {
            pool: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn save_update(
        &self,
        instance_id: &str,
        update: UpdateInput,
    ) -> Result<SavedUpdate, rusqlite::Error> {
        let conn = self.pool.lock().unwrap();

        let max_serial: i64 = conn.query_row(
            "SELECT COALESCE(MAX(serial), 0) FROM webxdc_updates WHERE instance_id = ?1",
            params![instance_id],
            |row| row.get(0),
        ).unwrap_or(0);

        let serial = max_serial + 1;

        conn.execute(
            "INSERT INTO webxdc_updates
             (instance_id, serial, max_serial, payload, info, document, summary, sender_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                instance_id,
                serial,
                serial,
                serde_json::to_string(&update.payload).unwrap(),
                update.info,
                update.document,
                update.summary,
                update.sender,
                update.timestamp,
            ],
        )?;

        Ok(SavedUpdate {
            serial,
            max_serial: serial,
            payload: update.payload,
            info: update.info,
            document: update.document,
            summary: update.summary,
            sender: update.sender,
            timestamp: update.timestamp,
        })
    }

    pub fn get_updates(
        &self,
        instance_id: &str,
        from_serial: Option<i64>,
    ) -> Result<Vec<WebxdcUpdate>, rusqlite::Error> {
        let conn = self.pool.lock().unwrap();

        let mut updates = Vec::new();

        if let Some(serial) = from_serial {
            let mut stmt = conn.prepare(
                "SELECT serial, max_serial, payload, info, document, summary, sender_id, timestamp
                 FROM webxdc_updates
                 WHERE instance_id = ?1 AND serial > ?2
                 ORDER BY serial ASC"
            )?;

            let rows = stmt.query_map(params![instance_id, serial], |row| {
                Ok(WebxdcUpdate {
                    serial: row.get(0)?,
                    max_serial: row.get(1)?,
                    payload: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                    info: row.get(3)?,
                    document: row.get(4)?,
                    summary: row.get(5)?,
                    sender: row.get(6)?,
                    timestamp: row.get(7)?,
                })
            })?;

            for row in rows {
                updates.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT serial, max_serial, payload, info, document, summary, sender_id, timestamp
                 FROM webxdc_updates
                 WHERE instance_id = ?1
                 ORDER BY serial ASC"
            )?;

            let rows = stmt.query_map(params![instance_id], |row| {
                Ok(WebxdcUpdate {
                    serial: row.get(0)?,
                    max_serial: row.get(1)?,
                    payload: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                    info: row.get(3)?,
                    document: row.get(4)?,
                    summary: row.get(5)?,
                    sender: row.get(6)?,
                    timestamp: row.get(7)?,
                })
            })?;

            for row in rows {
                updates.push(row?);
            }
        }

        Ok(updates)
    }

    #[allow(dead_code)]
    pub fn save_metadata(
        &self,
        instance_id: &str,
        metadata: InstanceMetadata,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.pool.lock().unwrap();

        conn.execute(
            "INSERT OR REPLACE INTO webxdc_metadata
             (instance_id, extract_path, manifest_json, last_opened, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                instance_id,
                metadata.extract_path,
                serde_json::to_string(&metadata.manifest).unwrap(),
                metadata.last_opened,
                metadata.created_at,
            ],
        )?;

        Ok(())
    }

    pub fn get_stale_instances(
        &self,
        older_than: Duration,
    ) -> Result<Vec<StaleInstance>, rusqlite::Error> {
        let conn = self.pool.lock().unwrap();
        let cutoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64 - older_than.as_secs() as i64;

        let mut stmt = conn.prepare(
            "SELECT instance_id, extract_path
             FROM webxdc_metadata
             WHERE last_opened < ?1"
        )?;

        let instances = stmt.query_map(params![cutoff], |row| {
            Ok(StaleInstance {
                instance_id: row.get(0)?,
                extract_path: row.get(1)?,
            })
        })?;

        instances.collect()
    }

    /// Cheogram-compatible realtime channel: the `<thread>` value correlating
    /// a webxdc app instance's update/realtime messages across peers.
    /// Immutable once set — first write wins, whether that's our own mint or
    /// a value adopted from a peer's incoming message.
    pub fn get_thread_id(&self, instance_id: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.pool.lock().unwrap();
        conn.query_row(
            "SELECT thread_id FROM webxdc_threads WHERE instance_id = ?1",
            params![instance_id],
            |row| row.get(0),
        ).optional()
    }

    /// Returns the instance's thread_id, minting and persisting a fresh UUID
    /// v4 the first time it's called for that instance.
    pub fn get_or_create_thread_id(&self, instance_id: &str) -> Result<String, rusqlite::Error> {
        if let Some(existing) = self.get_thread_id(instance_id)? {
            return Ok(existing);
        }
        let minted = uuid::Uuid::new_v4().to_string();
        self.set_thread_id_if_absent(instance_id, &minted)?;
        // Re-read: if a concurrent caller inserted first, INSERT OR IGNORE
        // above no-op'd and we must return THEIR value, not ours.
        Ok(self.get_thread_id(instance_id)?.unwrap_or(minted))
    }

    /// Persists `thread_id` for `instance_id` only if none is stored yet.
    /// Used to adopt a peer's `<thread>` value from an incoming update.
    pub fn set_thread_id_if_absent(&self, instance_id: &str, thread_id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.pool.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO webxdc_threads (instance_id, thread_id) VALUES (?1, ?2)",
            params![instance_id, thread_id],
        )?;
        Ok(())
    }

    /// Reverse lookup: find instance_id by thread_id (for incoming Cheogram updates).
    pub fn get_instance_by_thread(&self, thread_id: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.pool.lock().unwrap();
        conn.query_row(
            "SELECT instance_id FROM webxdc_threads WHERE thread_id = ?1",
            params![thread_id],
            |row| row.get(0),
        )
        .optional()
    }

    /// Clone an instance's update database to a new instance ID
    pub fn clone_instance(&self, from_id: &str, to_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let updates = self.get_updates(from_id, Some(0))?;

        // Copy all updates to new instance
        for update in updates {
            let input = UpdateInput {
                payload: update.payload,
                info: update.info,
                document: update.document,
                summary: update.summary,
                sender: update.sender,
                timestamp: update.timestamp,
            };
            self.save_update(to_id, input)?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn mock_update() -> UpdateInput {
        UpdateInput {
            payload: serde_json::json!({"test": "data"}),
            info: Some("test info".to_string()),
            document: None,
            summary: None,
            sender: "user@example.com".to_string(),
            timestamp: 1234567890,
        }
    }

    #[test]
    fn test_auto_increment_serial() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        let update1 = storage.save_update("instance1", mock_update()).unwrap();
        assert_eq!(update1.serial, 1);

        let update2 = storage.save_update("instance1", mock_update()).unwrap();
        assert_eq!(update2.serial, 2);

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_separate_serials_per_instance() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        let u1 = storage.save_update("instance1", mock_update()).unwrap();
        let u2 = storage.save_update("instance2", mock_update()).unwrap();

        assert_eq!(u1.serial, 1);
        assert_eq!(u2.serial, 1);

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_or_create_thread_id_mints_once_and_is_stable() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        let first = storage.get_or_create_thread_id("instance1").unwrap();
        let second = storage.get_or_create_thread_id("instance1").unwrap();

        assert_eq!(first, second);
        assert!(!first.is_empty());

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_or_create_thread_id_differs_per_instance() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        let a = storage.get_or_create_thread_id("instance1").unwrap();
        let b = storage.get_or_create_thread_id("instance2").unwrap();

        assert_ne!(a, b);

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_thread_id_returns_none_when_unset() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        assert_eq!(storage.get_thread_id("nonexistent").unwrap(), None);

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_set_thread_id_if_absent_is_first_write_wins() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        storage.set_thread_id_if_absent("instance1", "peer-thread").unwrap();
        storage.set_thread_id_if_absent("instance1", "different-thread").unwrap();

        assert_eq!(storage.get_thread_id("instance1").unwrap(), Some("peer-thread".to_string()));

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_set_thread_id_if_absent_then_get_or_create_reuses_it() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        storage.set_thread_id_if_absent("instance1", "peer-thread").unwrap();

        assert_eq!(storage.get_or_create_thread_id("instance1").unwrap(), "peer-thread");

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_instance_by_thread_reverse_lookup() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();
        storage.set_thread_id_if_absent("conv:app.xdc", "thread-abc").unwrap();

        let found = storage.get_instance_by_thread("thread-abc").unwrap();

        assert_eq!(found, Some("conv:app.xdc".to_string()));

        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_get_instance_by_thread_returns_none_for_unknown() {
        let temp = temp_dir().join(format!("webxdc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();

        let storage = WebxdcStorage::new(temp.clone()).unwrap();

        let found = storage.get_instance_by_thread("unknown-thread").unwrap();

        assert_eq!(found, None);

        std::fs::remove_dir_all(&temp).ok();
    }
}
