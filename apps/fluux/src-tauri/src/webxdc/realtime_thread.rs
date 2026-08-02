use std::collections::HashMap;
use std::sync::Mutex;

/// Tracks webxdc instances currently "joined" to the Cheogram-compatible
/// realtime channel. Unlike the legacy MUC-based `RealtimeChannelManager`,
/// join/leave involve no XMPP traffic at all — this is pure local
/// bookkeeping used to route incoming thread-tagged messages back to the
/// right webxdc instance while its window is open.
pub struct ThreadRealtimeManager {
    instances: Mutex<HashMap<String, InstanceChannel>>,
}

struct InstanceChannel {
    conversation_id: String,
    thread_id: String,
}

impl Default for ThreadRealtimeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ThreadRealtimeManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }

    /// Registers (or re-registers) an instance as joined. Idempotent —
    /// rejoining simply overwrites the previous mapping.
    pub fn join(&self, instance_id: String, conversation_id: String, thread_id: String) {
        let mut instances = self.instances.lock().unwrap();
        instances.insert(instance_id, InstanceChannel { conversation_id, thread_id });
    }

    /// Returns `(conversation_id, thread_id)` for a joined instance.
    pub fn get(&self, instance_id: &str) -> Option<(String, String)> {
        let instances = self.instances.lock().unwrap();
        instances.get(instance_id).map(|c| (c.conversation_id.clone(), c.thread_id.clone()))
    }

    /// Unregisters an instance, returning its last `(conversation_id, thread_id)`.
    pub fn leave(&self, instance_id: &str) -> Option<(String, String)> {
        let mut instances = self.instances.lock().unwrap();
        instances.remove(instance_id).map(|c| (c.conversation_id, c.thread_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_join_then_get() {
        let manager = ThreadRealtimeManager::new();
        manager.join("instance1".into(), "conv1".into(), "thread1".into());

        assert_eq!(
            manager.get("instance1"),
            Some(("conv1".to_string(), "thread1".to_string()))
        );
    }

    #[test]
    fn test_get_unknown_instance_returns_none() {
        let manager = ThreadRealtimeManager::new();
        assert_eq!(manager.get("nonexistent"), None);
    }

    #[test]
    fn test_leave_removes_and_returns_mapping() {
        let manager = ThreadRealtimeManager::new();
        manager.join("instance1".into(), "conv1".into(), "thread1".into());

        let left = manager.leave("instance1");

        assert_eq!(left, Some(("conv1".to_string(), "thread1".to_string())));
        assert_eq!(manager.get("instance1"), None);
    }

    #[test]
    fn test_leave_unknown_instance_returns_none() {
        let manager = ThreadRealtimeManager::new();
        assert_eq!(manager.leave("nonexistent"), None);
    }

    #[test]
    fn test_rejoin_after_leave_overwrites_mapping() {
        let manager = ThreadRealtimeManager::new();
        manager.join("instance1".into(), "conv1".into(), "thread1".into());
        manager.leave("instance1");
        manager.join("instance1".into(), "conv2".into(), "thread2".into());

        assert_eq!(
            manager.get("instance1"),
            Some(("conv2".to_string(), "thread2".to_string()))
        );
    }
}
