//! Caption event mapping (#11): livecap-core [`CaptionEvent`]s → the wire
//! shapes the webview and the session host consume (src/protocol.ts).
//! Channel identity is them/me (PROPOSAL §7.3: alignment is the only label);
//! confidence collapses to a low-confidence flag (design state 4).

use livecap_core::{CaptionEvent, CaptionKind, Channel};
use serde::Serialize;

/// Below this whisper confidence a finalized caption renders with the
/// `(?)` low-confidence treatment (design/system/design-system.png state 4).
pub const LOW_CONFIDENCE_THRESHOLD: f32 = 0.6;

/// `system` audio is what the user hears (them); `mic` is what they say (me).
pub fn channel_label(channel: Channel) -> &'static str {
    match channel {
        Channel::System => "them",
        Channel::Mic => "me",
    }
}

/// Wire shape of one caption event (webview event `caption://event`; the
/// finalized variant is also forwarded to the host as a "caption" message).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BridgeCaption {
    #[serde(rename_all = "camelCase")]
    Partial { channel: &'static str, text: String },
    /// The channel's in-progress partial was dropped without finalizing (#62):
    /// a mic utterance suppressed as speaker bleed (#56). The webview clears the
    /// channel's streaming block; never enters the translation queue.
    #[serde(rename_all = "camelCase")]
    Cleared { channel: &'static str },
    #[serde(rename_all = "camelCase")]
    Finalized {
        id: u64,
        channel: &'static str,
        text: String,
        lang: String,
        low_confidence: bool,
        epoch_ms: u64,
    },
}

impl BridgeCaption {
    /// Map a pipeline event. `next_id` is consulted only for finalized
    /// events (ids are per-session monotonic and double as queue sequence).
    pub fn from_event(event: CaptionEvent, next_id: impl FnOnce() -> u64, epoch_ms: u64) -> Self {
        let channel = channel_label(event.channel);
        match event.kind {
            CaptionKind::Partial(text) => BridgeCaption::Partial { channel, text },
            CaptionKind::PartialDropped => BridgeCaption::Cleared { channel },
            CaptionKind::Finalized {
                text,
                lang,
                confidence,
                ..
            } => BridgeCaption::Finalized {
                id: next_id(),
                channel,
                text,
                lang,
                low_confidence: confidence < LOW_CONFIDENCE_THRESHOLD,
                epoch_ms,
            },
        }
    }

    /// The host-stdin message for a finalized caption (`None` for partials —
    /// only finalized sentences enter the translation queue).
    pub fn host_message(&self) -> Option<serde_json::Value> {
        match self {
            BridgeCaption::Partial { .. } | BridgeCaption::Cleared { .. } => None,
            BridgeCaption::Finalized {
                id,
                channel,
                text,
                low_confidence,
                epoch_ms,
                ..
            } => Some(serde_json::json!({
                "type": "caption",
                "id": id,
                "channel": channel,
                "text": text,
                "lowConfidence": low_confidence,
                "epochMs": epoch_ms,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finalized(channel: Channel, confidence: f32) -> CaptionEvent {
        CaptionEvent {
            channel,
            kind: CaptionKind::Finalized {
                text: "hello there".into(),
                lang: "en".into(),
                confidence,
                start_ms: 0,
                end_ms: 900,
            },
        }
    }

    #[test]
    fn system_is_them_and_mic_is_me() {
        assert_eq!(channel_label(Channel::System), "them");
        assert_eq!(channel_label(Channel::Mic), "me");
    }

    #[test]
    fn partial_maps_without_consuming_an_id() {
        let event = CaptionEvent {
            channel: Channel::System,
            kind: CaptionKind::Partial("and I had, um".into()),
        };
        let mapped = BridgeCaption::from_event(event, || panic!("partial must not take an id"), 1);
        let json = serde_json::to_value(&mapped).unwrap();
        assert_eq!(json["type"], "partial");
        assert_eq!(json["channel"], "them");
        assert_eq!(json["text"], "and I had, um");
        assert!(mapped.host_message().is_none());
    }

    #[test]
    fn partial_dropped_maps_to_cleared_without_consuming_an_id() {
        let event = CaptionEvent {
            channel: Channel::Mic,
            kind: CaptionKind::PartialDropped,
        };
        let mapped =
            BridgeCaption::from_event(event, || panic!("cleared must not take an id"), 1);
        let json = serde_json::to_value(&mapped).unwrap();
        assert_eq!(json["type"], "cleared");
        assert_eq!(json["channel"], "me");
        // A cleared event is webview-only — it never enters the translation queue.
        assert!(mapped.host_message().is_none());
    }

    #[test]
    fn finalized_maps_with_id_lang_and_confidence_flag() {
        let mapped = BridgeCaption::from_event(finalized(Channel::Mic, 0.9), || 7, 1234);
        let json = serde_json::to_value(&mapped).unwrap();
        assert_eq!(json["type"], "finalized");
        assert_eq!(json["id"], 7);
        assert_eq!(json["channel"], "me");
        assert_eq!(json["lang"], "en");
        assert_eq!(json["lowConfidence"], false);
        assert_eq!(json["epochMs"], 1234);
    }

    #[test]
    fn low_confidence_threshold_flags_uncertain_captions() {
        let low = BridgeCaption::from_event(finalized(Channel::System, 0.3), || 1, 0);
        let high = BridgeCaption::from_event(finalized(Channel::System, 0.6), || 2, 0);
        assert_eq!(serde_json::to_value(&low).unwrap()["lowConfidence"], true);
        assert_eq!(serde_json::to_value(&high).unwrap()["lowConfidence"], false);
    }

    #[test]
    fn host_message_mirrors_the_finalized_wire_shape() {
        let mapped = BridgeCaption::from_event(finalized(Channel::System, 0.2), || 3, 99);
        let msg = mapped.host_message().unwrap();
        assert_eq!(msg["type"], "caption");
        assert_eq!(msg["id"], 3);
        assert_eq!(msg["channel"], "them");
        assert_eq!(msg["text"], "hello there");
        assert_eq!(msg["lowConfidence"], true);
        assert_eq!(msg["epochMs"], 99);
    }
}
