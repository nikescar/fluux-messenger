use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Tracks active realtime channels per WebXDC instance
#[allow(dead_code)]
pub struct RealtimeChannelManager {
    /// Map: instance_id -> RealtimeChannel
    channels: Arc<Mutex<HashMap<String, RealtimeChannel>>>,
}

#[allow(dead_code)]
struct RealtimeChannel {
    instance_id: String,
    conversation_id: String,
    room_jid: String,
    joined: bool,
}

#[allow(dead_code)]
pub fn compute_realtime_room_name(instance_id: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(instance_id.as_bytes());
    let hash = hasher.finalize();
    let hash_bytes: &[u8] = &hash[..8];
    format!("webxdc-rt-{}", hex::encode(hash_bytes))
}

impl Default for RealtimeChannelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RealtimeChannelManager {
    pub fn new() -> Self {
        Self {
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[allow(dead_code)]
    pub fn join(
        &self,
        instance_id: String,
        conversation_id: String,
    ) -> Result<String, String> {
        let mut channels = self.channels.lock().unwrap();

        if channels.contains_key(&instance_id) {
            return Err("Already joined a realtime channel".to_string());
        }

        // Generate unique room JID (template, frontend fills in muc_service)
        let room_local = compute_realtime_room_name(&instance_id);
        let room_jid = format!("{}@{{muc_service}}", room_local);

        let channel = RealtimeChannel {
            instance_id: instance_id.clone(),
            conversation_id,
            room_jid: room_jid.clone(),
            joined: false,
        };

        channels.insert(instance_id, channel);

        Ok(room_jid)
    }

    #[allow(dead_code)]
    pub fn get_room_jid(&self, instance_id: &str) -> Option<String> {
        let channels = self.channels.lock().unwrap();
        channels.get(instance_id).map(|c| c.room_jid.clone())
    }

    #[allow(dead_code)]
    pub fn leave(&self, instance_id: &str) -> Option<String> {
        let mut channels = self.channels.lock().unwrap();
        channels.remove(instance_id).map(|c| c.room_jid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_room_name_generation() {
        let instance_id = "conv123:https://example.com/app.xdc";
        let room_name = compute_realtime_room_name(instance_id);

        assert!(room_name.starts_with("webxdc-rt-"));
        assert_eq!(room_name.len(), "webxdc-rt-".len() + 16); // 8 bytes hex = 16 chars

        // Same instance ID produces same room name
        let room_name2 = compute_realtime_room_name(instance_id);
        assert_eq!(room_name, room_name2);
    }

    #[test]
    fn test_channel_manager_prevents_double_join() {
        let manager = RealtimeChannelManager::new();

        manager.join("instance1".into(), "conv1".into()).unwrap();
        let result = manager.join("instance1".into(), "conv1".into());

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Already joined a realtime channel");
    }

    #[test]
    fn test_channel_manager_leave() {
        let manager = RealtimeChannelManager::new();

        let room_jid = manager.join("instance1".into(), "conv1".into()).unwrap();
        let left_room = manager.leave("instance1");

        assert_eq!(left_room, Some(room_jid));

        // Can rejoin after leaving
        let result = manager.join("instance1".into(), "conv1".into());
        assert!(result.is_ok());
    }

    #[test]
    fn test_get_room_jid() {
        let manager = RealtimeChannelManager::new();

        let room_jid = manager.join("instance1".into(), "conv1".into()).unwrap();

        assert_eq!(manager.get_room_jid("instance1"), Some(room_jid.clone()));
        assert_eq!(manager.get_room_jid("nonexistent"), None);
    }
}
